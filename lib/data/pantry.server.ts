import "server-only";

import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE, MENU_SAVE_FAILURE_MESSAGE } from "@/lib/data/queryError";
import { calculatePantryPriceImpact, type PantryImpactRow } from "@/lib/calc/pantryImpact";
import { packToCostPerBaseMicros, toBaseUnitQuantity, type BaseUnit, type RecipeDisplayUnit, type IngredientUnitConversion } from "@/lib/calc/recipeUnits";
import { PANTRY_STARTERS_BY_KEY } from "@/lib/menu/pantryStarter";
import { RECIPE_TEMPLATES_BY_KEY, recipeSizesFor, templateRecipeForSize, scaledTemplateLines, type TemplateLine, type RecipeTemplateKey } from "@/lib/menu/recipeTemplates";

type Db = Awaited<ReturnType<typeof createServerSupabaseClient>>;
type Scope = { db: Db; businessId: string; today: string };
type PantryFailure = { ok: false; error: string; missingPantry?: string[]; missingConversions?: string[] };
type PantrySuccess = { ok: true; itemIds?: string[]; addedKeys?: string[] };
type PantryResult = PantryFailure | PantrySuccess;
type Ingredient = { id: string; name: string; base_unit: BaseUnit; starter_key: string | null; category: string | null };
type StoredLine = { menu_item_id: string; ingredient_id: string; quantity: number; display_unit: string | null; display_quantity: number | null };
type ReplacementLine = { ingredientId: string; quantity: number; displayUnit: RecipeDisplayUnit; displayQuantity: number };

async function activeScope(): Promise<Scope | null> {
  if (!isSupabaseConfigured()) return null;
  const db = await createServerSupabaseClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);
  const { data: business, error } = await db.from("businesses").select("timezone").eq("id", businessId).single();
  if (error || !business) return null;
  let today: string;
  try { today = formatInTimeZone(new Date(), business.timezone || "America/Los_Angeles", "yyyy-MM-dd"); }
  catch { return null; }
  return { db, businessId, today };
}
const bad = (error: string): PantryFailure => ({ ok: false, error });
const saveFailed = (): PantryFailure => bad(MENU_SAVE_FAILURE_MESSAGE);
function queryFailed(operation: string, error: { message: string } | null): PantryFailure {
  logQueryError(operation, error);
  return saveFailed();
}
const uuid = z.string().uuid();
const packInput = z.object({
  ingredientId: uuid,
  packQuantity: z.number().finite().positive().max(1_000_000),
  packUnit: z.string().regex(/^(gal|qt|l|ml|fl_oz|lb|kg|oz_wt|g|oz|each|dozen|case\([1-9][0-9]*\))$/),
  packCostCents: z.number().int().positive().max(1_000_000_000),
}).strict();

async function currentPrices(scope: Scope, ids: string[]) {
  if (!ids.length) return new Map<string, { cost: number; packQuantity: number | null; packUnit: string | null; packCostCents: number | null }>();
  const { data, error } = await scope.db.from("ingredient_prices")
    .select("ingredient_id, cost_per_base_unit_micros, pack_quantity, pack_unit, pack_cost_cents")
    .in("ingredient_id", ids).lte("effective_from", scope.today)
    .order("effective_from", { ascending: true })
    .order("recorded_at", { ascending: true })
    .order("id", { ascending: true });
  if (error || !data || data.length >= 1000) {
    logQueryError("pantry:currentPrices", error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const prices = new Map<string, { cost: number; packQuantity: number | null; packUnit: string | null; packCostCents: number | null }>();
  for (const row of data) prices.set(row.ingredient_id, {
    cost: Number(row.cost_per_base_unit_micros),
    packQuantity: row.pack_quantity === null ? null : Number(row.pack_quantity),
    packUnit: row.pack_unit, packCostCents: row.pack_cost_cents === null ? null : Number(row.pack_cost_cents),
  });
  return prices;
}

/** Current pack pricing is shared by all recipes; unknown cost stays null, never free. */
export async function listPantry(): Promise<Array<{
  id: string; name: string; category: string | null; starterKey: string | null; baseUnit: BaseUnit;
  costPerBaseMicros: number | null; packQuantity: number | null; packUnit: string | null;
  packCostCents: number | null; usedInCount: number;
}>> {
  const scope = await activeScope();
  if (!scope) return [];
  const { data, error } = await scope.db.from("ingredients")
    .select("id, name, base_unit, category, starter_key").eq("business_id", scope.businessId).order("name");
  if (error || !data || data.length >= 1000) throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  const ids = data.map((r) => r.id);
  const [prices, uses] = await Promise.all([
    currentPrices(scope, ids),
    ids.length ? scope.db.from("recipe_lines")
      .select("ingredient_id, menu_items!inner(business_id)")
      .in("ingredient_id", ids).eq("menu_items.business_id", scope.businessId) : Promise.resolve({ data: [], error: null }),
  ]);
  if (uses.error || !uses.data || uses.data.length >= 1000) throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  const counts = new Map<string, number>();
  for (const row of uses.data) counts.set(row.ingredient_id, (counts.get(row.ingredient_id) ?? 0) + 1);
  return data.map((ingredient) => {
    const price = prices.get(ingredient.id);
    return {
      id: ingredient.id, name: ingredient.name, category: ingredient.category,
      starterKey: ingredient.starter_key, baseUnit: ingredient.base_unit as BaseUnit,
      costPerBaseMicros: price?.cost ?? null, packQuantity: price?.packQuantity ?? null,
      packUnit: price?.packUnit ?? null, packCostCents: price?.packCostCents ?? null,
      usedInCount: counts.get(ingredient.id) ?? 0,
    };
  });
}

/** One RPC transaction uses the database's partial unique index to handle concurrent
 * "add starters" requests. Retrying is safe and preserves edited pump/shot conversions. */
export async function addFromStarter(keys: string[]): Promise<PantryResult> {
  const parsed = z.array(z.string().trim().min(1)).min(1).max(80).safeParse(keys);
  if (!parsed.success) return bad("invalid_starter_keys");
  const chosen = [...new Set(parsed.data)];
  if (chosen.some((key) => !PANTRY_STARTERS_BY_KEY.has(key))) return bad("unknown_starter_key");
  const scope = await activeScope();
  if (!scope) return bad("sign_in_required");
  const items = chosen.map((key) => {
    const starter = PANTRY_STARTERS_BY_KEY.get(key)!;
    return { starterKey: starter.key, name: starter.name, baseUnit: starter.baseUnit,
      category: starter.category, operationalUnit: starter.operationalUnit ?? null,
      baseUnitsPerOperationalUnit: starter.baseUnitsPerOperationalUnit ?? null };
  });
  const { data, error } = await scope.db.rpc("pantry_add_starters", {
    p_business_id: scope.businessId, p_items: items,
  });
  if (error) return queryFailed("pantry:addFromStarter:atomic", error);
  return { ok: true, addedKeys: (data as { addedKeys?: string[] } | null)?.addedKeys ?? [] };
}

export async function savePackPrice(input: z.infer<typeof packInput>): Promise<PantryResult> {
  const parsed = packInput.safeParse(input);
  if (!parsed.success) return bad("invalid_pack");
  const scope = await activeScope();
  if (!scope) return bad("sign_in_required");
  const { data: ingredient, error } = await scope.db.from("ingredients")
    .select("id, base_unit").eq("id", parsed.data.ingredientId).eq("business_id", scope.businessId).single();
  if (error || !ingredient) return bad("ingredient_not_found");
  const micros = packToCostPerBaseMicros(parsed.data.packQuantity, parsed.data.packUnit,
    parsed.data.packCostCents, ingredient.base_unit as BaseUnit);
  if (micros === null) return bad("pack_unit_mismatch");
  const { error: writeError } = await scope.db.from("ingredient_prices").insert({
    ingredient_id: ingredient.id, effective_from: scope.today,
    source: "manual", cost_per_base_unit_micros: micros,
    pack_quantity: parsed.data.packQuantity, pack_unit: parsed.data.packUnit,
    pack_cost_cents: parsed.data.packCostCents,
  });
  if (writeError) return queryFailed("pantry:savePackPrice", writeError);
  return { ok: true };
}

export async function previewPriceImpact(input: z.infer<typeof packInput>): Promise<
  | { ok: true; affectedItems: PantryImpactRow[]; costPerBaseMicros: number }
  | PantryFailure
> {
  const parsed = packInput.safeParse(input);
  if (!parsed.success) return bad("invalid_pack");
  const scope = await activeScope();
  if (!scope) return bad("sign_in_required");
  const { data: ingredient } = await scope.db.from("ingredients")
    .select("id, base_unit").eq("id", parsed.data.ingredientId).eq("business_id", scope.businessId).single();
  if (!ingredient) return bad("ingredient_not_found");
  const proposed = packToCostPerBaseMicros(parsed.data.packQuantity, parsed.data.packUnit,
    parsed.data.packCostCents, ingredient.base_unit as BaseUnit);
  if (proposed === null) return bad("pack_unit_mismatch");
  const { data: usage, error: usageError } = await scope.db.from("recipe_lines")
    .select("menu_item_id, menu_items!inner(business_id)")
    .eq("ingredient_id", ingredient.id).eq("menu_items.business_id", scope.businessId);
  if (usageError || !usage) return queryFailed("pantry:preview:usage", usageError);
  const itemIds = [...new Set(usage.map((row) => row.menu_item_id))];
  if (!itemIds.length) return { ok: true, costPerBaseMicros: proposed, affectedItems: [] };
  const [itemsResult, linesResult, fallbackResult] = await Promise.all([
    scope.db.from("menu_items").select("id, name, price_cents").eq("business_id", scope.businessId).in("id", itemIds),
    scope.db.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", itemIds),
    scope.db.from("menu_item_cost_fallbacks").select("menu_item_id, cost_cents").eq("business_id", scope.businessId).in("menu_item_id", itemIds),
  ]);
  if (itemsResult.error || linesResult.error || fallbackResult.error || !itemsResult.data || !linesResult.data || !fallbackResult.data)
    return bad("preview_unavailable");
  const lines = linesResult.data as StoredLine[];
  const prices = await currentPrices(scope, [...new Set(lines.map((line) => line.ingredient_id))]);
  const beforePrices = Object.fromEntries([...prices].map(([id, value]) => [id, value.cost]));
  const afterPrices = { ...beforePrices, [ingredient.id]: proposed };
  const fallbacks = new Map(fallbackResult.data.map((row) => [row.menu_item_id, Number(row.cost_cents)]));
  const affectedItems = calculatePantryPriceImpact(
    itemsResult.data.map((item) => ({
      id: item.id, name: item.name,
      priceCents: item.price_cents === null ? null : Number(item.price_cents),
    })),
    lines.map((line) => ({
      menuItemId: line.menu_item_id, ingredientId: line.ingredient_id,
      quantity: Number(line.quantity),
    })),
    beforePrices, ingredient.id, proposed, Object.fromEntries(fallbacks),
  );
  return { ok: true, costPerBaseMicros: proposed, affectedItems };
}

async function productSiblings(scope: Scope, productId: string) {
  const { data: selected } = await scope.db.from("menu_items")
    .select("id, base_name, size_label").eq("business_id", scope.businessId).eq("id", productId).single();
  if (!selected) return null;
  const { data: siblings, error } = await scope.db.from("menu_items")
    .select("id, base_name, size_label").eq("business_id", scope.businessId).eq("base_name", selected.base_name);
  if (error || !siblings) return null;
  return siblings;
}
async function conversionsFor(scope: Scope, ids: string[]) {
  if (!ids.length) return new Map<string, IngredientUnitConversion[]>();
  const { data, error } = await scope.db.from("ingredient_unit_conversions")
    .select("ingredient_id, unit, base_units_per_unit").in("ingredient_id", ids);
  if (error || !data) throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  const map = new Map<string, IngredientUnitConversion[]>();
  for (const row of data) {
    const entries = map.get(row.ingredient_id) ?? [];
    entries.push({ unit: row.unit as "shot" | "pump", baseUnitsPerUnit: Number(row.base_units_per_unit) });
    map.set(row.ingredient_id, entries);
  }
  return map;
}
async function verifiedWrite(scope: Scope, productId: string, changes: { menuItemId: string; lines: ReplacementLine[] }[]): Promise<PantryResult> {
  const { data, error } = await scope.db.rpc("pantry_replace_recipes", {
    p_business_id: scope.businessId, p_product_item_id: productId, p_changes: changes,
  });
  if (error) return queryFailed("pantry:replaceRecipes", error);
  return { ok: true, itemIds: (data as { itemIds?: string[] } | null)?.itemIds ?? [] };
}

export async function applyTemplate(productId: string, templateKey: RecipeTemplateKey): Promise<PantryResult> {
  if (!uuid.safeParse(productId).success || !RECIPE_TEMPLATES_BY_KEY.has(templateKey)) return bad("invalid_template");
  const scope = await activeScope();
  if (!scope) return bad("sign_in_required");
  const { data: product } = await scope.db.from("menu_items")
    .select("id").eq("business_id", scope.businessId).eq("id", productId).single();
  if (!product) return bad("product_not_found");
  const sizes = recipeSizesFor(templateKey);
  const recipes = sizes.map((sizeOz) => ({ sizeLabel: `${sizeOz} oz`, lines: templateRecipeForSize(templateKey, sizeOz)! }));
  const needed = [...new Set(recipes.flatMap((size) => size.lines.map((line) => line.starterKey)))];
  const { data: ingredients, error } = await scope.db.from("ingredients")
    .select("id, base_unit, starter_key").eq("business_id", scope.businessId).in("starter_key", needed);
  if (error) return queryFailed("pantry:applyTemplate:ingredients", error);
  const map = new Map((ingredients ?? []).map((row) => [row.starter_key, row]));
  const missingPantry = needed.filter((key) => !map.has(key));
  if (missingPantry.length) return { ok: false, error: "missing_pantry", missingPantry };
  const conversions = await conversionsFor(scope, (ingredients ?? []).map((item) => item.id));
  const missingConversions: string[] = [];
  const changes = recipes.map((recipe) => ({
    sizeLabel: recipe.sizeLabel,
    lines: recipe.lines.map((line) => {
      const ingredient = map.get(line.starterKey)!;
      const quantity = toBaseUnitQuantity(line.displayUnit, line.displayQuantity,
        ingredient.base_unit as BaseUnit, conversions.get(ingredient.id) ?? []);
      if (quantity === null) missingConversions.push(`${line.starterKey}:${line.displayUnit}`);
      return { ingredientId: ingredient.id, quantity, displayUnit: line.displayUnit,
        displayQuantity: line.displayQuantity };
    }),
  }));
  if (missingConversions.length) return { ok: false, error: "missing_conversions",
    missingConversions: [...new Set(missingConversions)] };
  const { data, error: applyError } = await scope.db.rpc("pantry_apply_sized_recipes", {
    p_business_id: scope.businessId, p_product_item_id: productId, p_sizes: changes,
  });
  if (applyError) return queryFailed("pantry:applyTemplate:atomic", applyError);
  return { ok: true, itemIds: (data as { itemIds?: string[] } | null)?.itemIds ?? [] };
}

export async function swapIngredient(productId: string, fromId: string, toId: string): Promise<PantryResult> {
  if (![productId, fromId, toId].every((id) => uuid.safeParse(id).success)) return bad("invalid_ingredient");
  const scope = await activeScope();
  if (!scope) return bad("sign_in_required");
  const siblings = await productSiblings(scope, productId);
  if (!siblings) return bad("product_not_found");
  const { data: ingredients, error: ingredientsError } = await scope.db.from("ingredients")
    .select("id, base_unit").eq("business_id", scope.businessId).in("id", [fromId, toId]);
  if (ingredientsError || !ingredients || ingredients.length !== (fromId === toId ? 1 : 2)) return bad("ingredient_not_found");
  const to = ingredients.find((ingredient) => ingredient.id === toId)!;
  if (fromId === toId) return { ok: true, itemIds: [] };
  const { data: rows, error } = await scope.db.from("recipe_lines")
    .select("menu_item_id, ingredient_id, quantity, display_unit, display_quantity")
    .in("menu_item_id", siblings.map((s) => s.id));
  if (error || !rows) return queryFailed("pantry:swap:lines", error);
  const { data: allBases, error: basesError } = await scope.db.from("ingredients")
    .select("id, base_unit").eq("business_id", scope.businessId)
    .in("id", [...new Set(rows.map((row) => row.ingredient_id))]);
  if (basesError || !allBases) return bad("ingredient_not_found");
  const byIngredientId = new Map(allBases.map((ingredient) => [ingredient.id, ingredient]));
  const conversions = await conversionsFor(scope, [toId]);
  const changes: { menuItemId: string; lines: ReplacementLine[] }[] = [];
  for (const sibling of siblings) {
    const existing = rows.filter((row) => row.menu_item_id === sibling.id);
    if (!existing.some((row) => row.ingredient_id === fromId)) continue;
    if (existing.some((row) => row.ingredient_id === toId)) return bad("ingredient_already_present");
    const lines: ReplacementLine[] = [];
    for (const row of existing) {
      const isChanged = row.ingredient_id === fromId;
      const originalIngredient = byIngredientId.get(row.ingredient_id);
      if (!originalIngredient) return bad("ingredient_not_found");
      const displayUnit = (row.display_unit || originalIngredient.base_unit) as RecipeDisplayUnit;
      const displayQuantity = row.display_quantity === null ? Number(row.quantity) : Number(row.display_quantity);
      const quantity = isChanged ? toBaseUnitQuantity(displayUnit, displayQuantity,
        to.base_unit as BaseUnit, conversions.get(toId) ?? []) : Number(row.quantity);
      if (quantity === null) return bad("ingredient_unit_mismatch");
      lines.push({ ingredientId: isChanged ? toId : row.ingredient_id,
        quantity, displayUnit, displayQuantity });
    }
    changes.push({ menuItemId: sibling.id, lines });
  }
  if (!changes.length) return bad("ingredient_not_in_product");
  return verifiedWrite(scope, productId, changes);
}

export async function scaleRecipeToSize(fromItemId: string, toItemId: string): Promise<PantryResult> {
  if (!uuid.safeParse(fromItemId).success || !uuid.safeParse(toItemId).success) return bad("invalid_item");
  const scope = await activeScope();
  if (!scope) return bad("sign_in_required");
  const siblings = await productSiblings(scope, fromItemId);
  const from = siblings?.find((item) => item.id === fromItemId);
  const to = siblings?.find((item) => item.id === toItemId);
  if (!from || !to) return bad("items_not_siblings");
  const fromSize = /^(\d+) oz$/.exec(from.size_label ?? "");
  const toSize = /^(\d+) oz$/.exec(to.size_label ?? "");
  if (!fromSize || !toSize) return bad("size_label_required");
  const fromOz = Number(fromSize[1]), toOz = Number(toSize[1]);
  const iced = fromOz === 24 || toOz === 24;
  const { data: source, error } = await scope.db.from("recipe_lines")
    .select("menu_item_id, ingredient_id, quantity, display_unit, display_quantity")
    .eq("menu_item_id", fromItemId);
  if (error || !source || !source.length) return bad("source_recipe_missing");
  const { data: available, error: ingredientsError } = await scope.db.from("ingredients")
    .select("id, base_unit, starter_key").eq("business_id", scope.businessId);
  if (ingredientsError || !available) return bad("ingredients_unavailable");
  const byId = new Map(available.map((ingredient) => [ingredient.id, ingredient]));
  const byKey = new Map(available.filter((ingredient) => ingredient.starter_key)
    .map((ingredient) => [ingredient.starter_key, ingredient]));
  const sourceAsTemplate = source.map((row) => {
    const ingredient = byId.get(row.ingredient_id);
    if (!ingredient) return null;
    return { starterKey: ingredient.starter_key ?? `custom:${ingredient.id}`,
      displayUnit: (row.display_unit ?? ingredient.base_unit) as RecipeDisplayUnit,
      displayQuantity: Number(row.display_quantity ?? row.quantity) };
  });
  if (sourceAsTemplate.some((line) => line === null)) return bad("ingredient_not_found");
  const scaled = scaledTemplateLines(sourceAsTemplate as TemplateLine[], fromOz, toOz, iced);
  const conversions = await conversionsFor(scope, available.map((i) => i.id));
  const lines: ReplacementLine[] = [];
  for (const value of scaled) {
    const ingredient = value.starterKey.startsWith("custom:")
      ? byId.get(value.starterKey.slice(7)) : byKey.get(value.starterKey);
    if (!ingredient) return { ok: false, error: "missing_pantry", missingPantry: [value.starterKey] };
    const quantity = toBaseUnitQuantity(value.displayUnit, value.displayQuantity,
      ingredient.base_unit as BaseUnit, conversions.get(ingredient.id) ?? []);
    if (quantity === null) return bad("ingredient_unit_mismatch");
    if (lines.some((line) => line.ingredientId === ingredient.id)) return bad("duplicate_ingredient");
    lines.push({ ingredientId: ingredient.id, quantity,
      displayUnit: value.displayUnit, displayQuantity: value.displayQuantity });
  }
  return verifiedWrite(scope, fromItemId, [{ menuItemId: toItemId, lines }]);
}
