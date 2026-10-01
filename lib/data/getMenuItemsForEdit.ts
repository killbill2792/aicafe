import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { evaluateRecipeCost, type RecipeCostStatus } from "@/lib/calc";
import type { MenuItemCategoryCode } from "@/lib/constants";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE } from "./queryError";

export type RecipeLineForEdit = {
  ingredientId: string;
  ingredientName: string;
  baseUnit: "g" | "ml" | "each";
  quantity: number;
  /** What the owner actually typed (e.g. "2 shots") and in what café-friendly unit — purely for
   * friendly re-display; null for older rows entered before café-friendly units existed, which
   * just fall back to showing `quantity`/`baseUnit`. Cost math always uses `quantity`/`baseUnit`. */
  displayUnit: string | null;
  displayQuantity: number | null;
  costCents: number | null;
  priceSource: "manual" | "receipt" | "statement" | "invoice" | null;
};
type RawRecipeLine = Omit<RecipeLineForEdit, "costCents" | "priceSource">;

export type MenuItemForEdit = {
  id: string;
  name: string;
  baseName: string;
  sizeLabel: string | null;
  priceCents: number;
  prepSeconds: number;
  category: MenuItemCategoryCode;
  /** Owner-facing menu section (e.g. "Coffee", "Breakfast") — separate from `category`, the
   * internal analytics code. Null until the owner (or a POS import) sets one. */
  menuGroup: string | null;
  active: boolean;
  posItemId: string | null;
  catalogSource: string;
  catalogLastSyncedAt: string | null;
  recipe: RecipeLineForEdit[];
  /** Today's priced ingredient cost for this item's current recipe — 0 when the recipe has no
   * ingredients yet, or none of them have a priced cost. Powers the "suggested price" hint. */
  ingredientsCostCents: number | null;
  costStatus: RecipeCostStatus;
  missingCostIngredientNames: string[];
};

export type IngredientOption = { id: string; name: string; baseUnit: "g" | "ml" | "each" };

/** Everything the "manage menu" screen needs: every menu item (active and inactive) with its
 * current recipe, plus the full ingredient list for the "pick an existing ingredient" dropdown. */
export async function getMenuItemsForEdit(): Promise<{ items: MenuItemForEdit[]; ingredients: IngredientOption[] }> {
  if (!isSupabaseConfigured()) return { items: [], ingredients: [] };
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { items: [], ingredients: [] };
  const businessId = await getActiveBusinessId(user.id);

  const [itemsResult, ingredientsResult, businessResult] = await Promise.all([
    supabase
      .from("menu_items")
      .select("id, name, base_name, size_label, price_cents, prep_seconds, category, menu_group, is_active, pos_item_id, catalog_source, catalog_last_synced_at")
      .eq("business_id", businessId)
      .order("name"),
    supabase.from("ingredients").select("id, name, base_unit").eq("business_id", businessId).order("name"),
    supabase.from("businesses").select("timezone").eq("id", businessId).single(),
  ]);
  if (itemsResult.error) {
    logQueryError("getMenuItemsForEdit:menu_items", itemsResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  if (ingredientsResult.error) {
    logQueryError("getMenuItemsForEdit:ingredients", ingredientsResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  // The business's timezone has a safe, documented fallback below, so a failure here degrades
  // gracefully rather than blocking the whole menu — still logged, never silently unnoticed.
  if (businessResult.error) logQueryError("getMenuItemsForEdit:businesses", businessResult.error);
  const items = itemsResult.data;
  const ingredients = ingredientsResult.data;
  const business = businessResult.data;
  const todayDateStr = formatInTimeZone(new Date(), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");

  const itemIds = (items ?? []).map((i) => i.id);
  const recipeLinesResult =
    itemIds.length > 0
      ? await supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity, display_unit, display_quantity, ingredients(name, base_unit)").in("menu_item_id", itemIds)
      : { data: [] as never[], error: null };
  if (recipeLinesResult.error) {
    logQueryError("getMenuItemsForEdit:recipe_lines", recipeLinesResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const recipeLines = recipeLinesResult.data;

  const ingredientOptions: IngredientOption[] = (ingredients ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    baseUnit: i.base_unit as "g" | "ml" | "each",
  }));

  const recipeByItem = new Map<string, RawRecipeLine[]>();
  for (const row of recipeLines ?? []) {
    const ing = row.ingredients as unknown as { name: string; base_unit: string } | { name: string; base_unit: string }[] | null;
    const ingRow = Array.isArray(ing) ? ing[0] : ing;
    if (!ingRow) continue;
    const list = recipeByItem.get(row.menu_item_id) ?? [];
    list.push({
      ingredientId: row.ingredient_id,
      ingredientName: ingRow.name,
      baseUnit: ingRow.base_unit as "g" | "ml" | "each",
      quantity: Number(row.quantity),
      displayUnit: row.display_unit ?? null,
      displayQuantity: row.display_quantity === null ? null : Number(row.display_quantity),
    });
    recipeByItem.set(row.menu_item_id, list);
  }

  // Latest priced-as-of-today cost per ingredient — same "ascending order, last write wins"
  // pattern getMenuItemSnapshots (lib/data/snapshot.server.ts) already uses for the read-only
  // Menu screen, reused here so the editor's "suggested price" is grounded in the same number.
  const recipeIngredientIds = [...new Set((recipeLines ?? []).map((r) => r.ingredient_id))];
  const priceRowsResult =
    recipeIngredientIds.length > 0
      ? await supabase
          .from("ingredient_prices")
          .select("ingredient_id, effective_from, cost_per_base_unit_micros, source")
          .in("ingredient_id", recipeIngredientIds)
          .lte("effective_from", todayDateStr)
          .order("effective_from", { ascending: true })
      : { data: [] as never[], error: null };
  if (priceRowsResult.error) {
    logQueryError("getMenuItemsForEdit:ingredient_prices", priceRowsResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const priceRows = priceRowsResult.data;
  const latestPriceMicros: Record<string, number> = {};
  const latestPriceSource: Record<string, RecipeLineForEdit["priceSource"]> = {};
  for (const row of priceRows ?? []) {
    latestPriceMicros[row.ingredient_id] = row.cost_per_base_unit_micros;
    latestPriceSource[row.ingredient_id] = row.source as RecipeLineForEdit["priceSource"];
  }

  const menuItems: MenuItemForEdit[] = (items ?? []).map((item) => {
    const recipe = (recipeByItem.get(item.id) ?? []).sort((a, b) => a.ingredientName.localeCompare(b.ingredientName));
    const cost = evaluateRecipeCost(
      recipe.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity })),
      latestPriceMicros,
    );
    const recipeWithCosts = recipe.map((line) => ({
      ...line,
      costCents: latestPriceMicros[line.ingredientId] === undefined
        ? null
        : (line.quantity * latestPriceMicros[line.ingredientId]) / 1_000_000,
      priceSource: latestPriceSource[line.ingredientId] ?? null,
    }));
    return {
      id: item.id,
      name: item.name,
      baseName: item.base_name ?? item.name,
      sizeLabel: item.size_label ?? null,
      priceCents: item.price_cents ?? 0,
      prepSeconds: item.prep_seconds,
      category: (item.category === "food" ? "FOOD" : item.category === "drink" ? "ESPRESSO_DRINK" : item.category) as MenuItemCategoryCode,
      menuGroup: item.menu_group ?? null,
      active: item.is_active,
      posItemId: item.pos_item_id ?? null,
      catalogSource: item.catalog_source ?? "manual",
      catalogLastSyncedAt: item.catalog_last_synced_at ?? null,
      recipe: recipeWithCosts,
      ingredientsCostCents: cost.costCents,
      costStatus: cost.status,
      missingCostIngredientNames: recipe.filter((line) => cost.missingIngredientIds.includes(line.ingredientId)).map((line) => line.ingredientName),
    };
  });

  return { items: menuItems, ingredients: ingredientOptions };
}
