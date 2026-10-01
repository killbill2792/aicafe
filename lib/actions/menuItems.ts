"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { MENU_ITEM_CATEGORY_CODES } from "@/lib/constants";
import { existingMenuGroups, normalizeMenuGroup } from "@/lib/menu/menuGroups";
import { inferMenuItemCategory } from "@/lib/menu/inferCategory";
import { copyRecipeLines } from "@/lib/menu/copyRecipeLines";
import { logQueryError, MENU_SAVE_FAILURE_MESSAGE } from "@/lib/data/queryError";
import { needsIngredientConversion, toBaseUnitQuantity, type BaseUnit, type IngredientUnitConversion, type RecipeDisplayUnit } from "@/lib/calc/recipeUnits";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type ActionResultWithId = { ok: true; id: string } | { ok: false; error: string };

async function currentBusinessId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return getActiveBusinessId(user.id);
}

/** A new ingredient price must be dated by the business's own "today", not the server's UTC
 * date — snapshot queries filter prices with effective_from <= business-local today, so a price
 * stamped with a later UTC date (e.g. entered in the evening in a timezone behind UTC) would be
 * silently excluded from every cost calculation until the server's date catches up. */
async function currentBusinessTodayDateStr(businessId: string, supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>): Promise<string> {
  const { data } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  return formatInTimeZone(new Date(), data?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");
}

/** Resolves the owner-typed menu group against this business's existing groups, logging (never
 * throwing a raw message to the owner) if that lookup itself fails. Returns null on failure so
 * callers can decide whether a missing group lookup should block the whole mutation. */
async function safeNormalizedMenuGroup(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  rawMenuGroup: string | undefined,
): Promise<{ ok: true; menuGroup: string | null } | { ok: false }> {
  if (!rawMenuGroup?.trim()) return { ok: true, menuGroup: null };
  try {
    return { ok: true, menuGroup: normalizeMenuGroup(rawMenuGroup, await existingMenuGroups(supabase, businessId)) };
  } catch (err) {
    logQueryError("safeNormalizedMenuGroup", err instanceof Error ? { message: err.message } : null);
    return { ok: false };
  }
}

const MenuItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sizeLabel: z.string().trim().max(20).optional(),
  priceCents: z.number().int().positive(),
  prepSeconds: z.number().int().positive().max(3600).optional(),
  category: z.enum(MENU_ITEM_CATEGORY_CODES).optional(),
  menuGroup: z.string().trim().max(40).optional(),
  /** When set on create, the new item's recipe is duplicated from this existing item (for "Add
   * another size" — a size usually shares its sibling's recipe to start from). Must belong to the
   * same active business — verified in copyRecipeLines, never assumed from the id alone. */
  copyRecipeFromItemId: z.string().uuid().optional(),
});

const DEFAULT_PREP_SECONDS = 60;

/** Adds a new menu item with no recipe yet — for register plans (CSV/Excel only, no live catalog
 * sync) where nothing ever creates `menu_items` rows automatically. Without this, the Menu screen
 * and every per-drink cost number stay permanently empty for those owners. `name` is treated as
 * the drink's base name ("Latte"); when a size is given, the stored `name` becomes "Latte 12 oz"
 * (the single string everything else in the app reads), while `base_name`/`size_label` are kept
 * alongside it so the editor can group sizes of the same drink together. `category` and
 * `prepSeconds` are optional — the simplified create flow (`/menu/new`) omits them and gets a
 * sane inferred default, editable later; nothing about this is asserted as owner-confirmed. */
export async function addMenuItem(input: z.infer<typeof MenuItemSchema>): Promise<ActionResultWithId> {
  const parsed = MenuItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name and price." };

  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();

  const sizeLabel = parsed.data.sizeLabel?.trim() || null;
  const fullName = sizeLabel ? `${parsed.data.name} ${sizeLabel}` : parsed.data.name;
  const menuGroupResult = await safeNormalizedMenuGroup(supabase, businessId, parsed.data.menuGroup);
  if (!menuGroupResult.ok) return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  const menuGroup = menuGroupResult.menuGroup;
  const category = parsed.data.category ?? inferMenuItemCategory(parsed.data.name, menuGroup);

  const { data, error } = await supabase
    .from("menu_items")
    .insert({
      business_id: businessId,
      name: fullName,
      base_name: parsed.data.name,
      size_label: sizeLabel,
      price_cents: parsed.data.priceCents,
      prep_seconds: parsed.data.prepSeconds ?? DEFAULT_PREP_SECONDS,
      category,
      menu_group: menuGroup,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !data) {
    logQueryError("addMenuItem:insert", error);
    return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  }

  if (parsed.data.copyRecipeFromItemId) {
    const copied = await copyRecipeLines(supabase, businessId, parsed.data.copyRecipeFromItemId, data.id);
    if (!copied) {
      // The owner explicitly asked to copy a recipe onto this size. Leaving the size behind with
      // no recipe, while reporting success, would silently misrepresent what happened — roll the
      // new item back so "Add size" either fully succeeds or fully fails, never half-and-half.
      const { error: rollbackError } = await supabase.from("menu_items").delete().eq("id", data.id).eq("business_id", businessId);
      if (rollbackError) logQueryError("addMenuItem:rollback", rollbackError);
      return { ok: false, error: "Could not copy the recipe to the new size. Nothing was added." };
    }
  }

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  revalidatePath("/");
  return { ok: true, id: data.id };
}

export async function setMenuItemActive(menuItemId: string, active: boolean): Promise<ActionResult> {
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { data: updated, error } = await supabase
    .from("menu_items")
    .update({ is_active: active })
    .eq("id", menuItemId)
    .eq("business_id", businessId)
    .select("id");
  if (error) {
    logQueryError("setMenuItemActive", error);
    return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  }
  // A user may legitimately belong to more than one business — matching 0 rows means this item
  // isn't actually owned by the active business, not that the (no-op) update "succeeded".
  if (!updated || updated.length === 0) return { ok: false, error: "Item not found." };

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  revalidatePath(`/menu/${menuItemId}`);
  return { ok: true };
}

const UpdateMenuItemSchema = MenuItemSchema.extend({ id: z.string().uuid(), category: z.enum(MENU_ITEM_CATEGORY_CODES), prepSeconds: z.number().int().positive().max(3600) });
export async function updateMenuItem(input: z.infer<typeof UpdateMenuItemSchema>): Promise<ActionResult> {
  const parsed = UpdateMenuItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name, price, and prep time." };
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };
  const supabase = await createServerSupabaseClient();
  const sizeLabel = parsed.data.sizeLabel?.trim() || null;
  const menuGroupResult = await safeNormalizedMenuGroup(supabase, businessId, parsed.data.menuGroup);
  if (!menuGroupResult.ok) return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  const { data: updated, error } = await supabase
    .from("menu_items")
    .update({
      name: sizeLabel ? `${parsed.data.name} ${sizeLabel}` : parsed.data.name,
      base_name: parsed.data.name,
      size_label: sizeLabel,
      price_cents: parsed.data.priceCents,
      prep_seconds: parsed.data.prepSeconds,
      category: parsed.data.category,
      menu_group: menuGroupResult.menuGroup,
    })
    .eq("id", parsed.data.id)
    .eq("business_id", businessId)
    .select("id");
  if (error) {
    logQueryError("updateMenuItem", error);
    return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  }
  if (!updated || updated.length === 0) return { ok: false, error: "Item not found." };
  revalidatePath("/menu"); revalidatePath(`/menu/${parsed.data.id}`); revalidatePath("/menu/manage");
  return { ok: true };
}

/** Distinct menu-group names already used by this business, for the create/edit form's
 * `<datalist>` suggestions — reusing an existing spelling instead of minting a near-duplicate. */
export async function getMenuGroupOptions(): Promise<string[]> {
  const businessId = await currentBusinessId();
  if (!businessId) return [];
  const supabase = await createServerSupabaseClient();
  return existingMenuGroups(supabase, businessId);
}

const IngredientPriceSchema = z.object({ ingredientId: z.string().uuid(), packageCostCents: z.number().int().positive(), packageQuantity: z.number().positive() });
/** Manual fallback still writes the canonical price-history table, never recipe-local cost data. */
export async function addManualIngredientPrice(input: z.infer<typeof IngredientPriceSchema>): Promise<ActionResult> {
  const parsed = IngredientPriceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter the package cost and quantity." };
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };
  const supabase = await createServerSupabaseClient();
  const { data: ingredient } = await supabase.from("ingredients").select("id").eq("id", parsed.data.ingredientId).eq("business_id", businessId).single();
  if (!ingredient) return { ok: false, error: "Ingredient not found." };
  const { error } = await supabase.from("ingredient_prices").insert({ ingredient_id: ingredient.id, effective_from: await currentBusinessTodayDateStr(businessId, supabase), cost_per_base_unit_micros: Math.round(parsed.data.packageCostCents / parsed.data.packageQuantity * 1_000_000), source: "manual" });
  if (error) {
    logQueryError("addManualIngredientPrice", error);
    return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  }
  revalidatePath("/menu"); revalidatePath("/menu/manage");
  return { ok: true };
}

const RecipeLineSchema = z.object({
  menuItemId: z.string().uuid(),
  ingredientId: z.string().uuid().optional(),
  newIngredientName: z.string().trim().max(60).optional(),
  newIngredientUnit: z.enum(["g", "ml", "each"]).optional(),
  /** What a whole package of the new ingredient costs, and how much of the base unit that
   * package holds — e.g. "$50 for 2000 g of beans". Both optional: an owner can add the
   * recipe now and price it later once they know the cost. */
  newIngredientCostCents: z.number().int().positive().optional(),
  newIngredientCostQuantity: z.number().positive().optional(),
  /** Café-friendly unit the owner actually typed (g/ml/fl oz/each/shot/pump) and the quantity in
   * that unit — converted to the ingredient's canonical base unit server-side before storage.
   * Never trust a client-converted number. */
  displayUnit: z.enum(["g", "ml", "fl_oz", "each", "shot", "pump"]),
  displayQuantity: z.number().positive(),
  /** Only present when displayUnit is shot/pump and this ingredient has no stored conversion yet
   * — defines it in this same step ("1 shot of Espresso Beans = 18 g") instead of a second round
   * trip. Scoped to this one ingredient; never a global constant (see lib/calc/recipeUnits.ts). */
  newConversionBaseUnitsPerUnit: z.number().positive().optional(),
});

/** Adds one recipe line (an ingredient + how much of it a drink uses, in a café-friendly unit).
 * Either an existing `ingredientId` or a `newIngredientName`+`newIngredientUnit` to create one
 * first — matches the same "confirm the unit for anything new" pattern as the ingredient-cost
 * importer. Both the menu item and the ingredient are verified to belong to the active business —
 * a user may legitimately belong to more than one, so RLS membership alone isn't a substitute for
 * checking this is the one currently in use. */
export async function addRecipeLine(input: z.infer<typeof RecipeLineSchema>): Promise<ActionResult> {
  const parsed = RecipeLineSchema.safeParse(input);
  if (!parsed.success || (!parsed.data.ingredientId && !parsed.data.newIngredientName)) {
    return { ok: false, error: "Pick an ingredient and a quantity." };
  }

  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();

  const { data: menuItem, error: menuItemError } = await supabase.from("menu_items").select("id").eq("id", parsed.data.menuItemId).eq("business_id", businessId).single();
  if (menuItemError) logQueryError("addRecipeLine:menuItem", menuItemError);
  if (!menuItem) return { ok: false, error: "Item not found." };

  let ingredientId = parsed.data.ingredientId;
  let ingredientBaseUnit: BaseUnit | null = null;
  if (!ingredientId) {
    // Match by name (case-insensitive) before creating — typing a name that already exists
    // should reuse it, not silently fork a second "Milk" with no way to tell them apart.
    const { data: existing, error: existingError } = await supabase
      .from("ingredients")
      .select("id, name, base_unit")
      .eq("business_id", businessId)
      .ilike("name", parsed.data.newIngredientName!);
    if (existingError) {
      logQueryError("addRecipeLine:ingredientLookup", existingError);
      return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
    }
    const matched = existing?.find((i) => i.name.toLowerCase() === parsed.data.newIngredientName!.toLowerCase());
    ingredientId = matched?.id;
    ingredientBaseUnit = (matched?.base_unit as BaseUnit) ?? null;

    if (!ingredientId) {
      ingredientBaseUnit = parsed.data.newIngredientUnit ?? "g";
      const { data: created, error: createError } = await supabase
        .from("ingredients")
        .insert({ business_id: businessId, name: parsed.data.newIngredientName, base_unit: ingredientBaseUnit })
        .select("id")
        .single();
      if (createError || !created) {
        logQueryError("addRecipeLine:createIngredient", createError);
        return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
      }
      ingredientId = created.id;
    }

    // A cost may be entered whether this reused a name match or just created the ingredient —
    // either way it's a new price point, so it's always worth recording.
    if (parsed.data.newIngredientCostCents && parsed.data.newIngredientCostQuantity) {
      // Same ×1,000,000 cents-to-micros convention as csvImport.ts — see the note there.
      const costPerBaseUnitMicros = Math.round((parsed.data.newIngredientCostCents / parsed.data.newIngredientCostQuantity) * 1_000_000);
      const { error: priceError } = await supabase.from("ingredient_prices").insert({
        ingredient_id: ingredientId,
        effective_from: await currentBusinessTodayDateStr(businessId, supabase),
        cost_per_base_unit_micros: costPerBaseUnitMicros,
        source: "manual",
      });
      if (priceError) {
        logQueryError("addRecipeLine:ingredientPrice", priceError);
        return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
      }
    }
  } else {
    const { data: existingIngredient, error: ingredientLookupError } = await supabase.from("ingredients").select("base_unit").eq("id", ingredientId).eq("business_id", businessId).single();
    if (ingredientLookupError) logQueryError("addRecipeLine:existingIngredient", ingredientLookupError);
    if (!existingIngredient) return { ok: false, error: "Ingredient not found." };
    ingredientBaseUnit = existingIngredient.base_unit as BaseUnit;
  }

  const displayUnit = parsed.data.displayUnit as RecipeDisplayUnit;
  let conversions: IngredientUnitConversion[] = [];
  if (needsIngredientConversion(displayUnit)) {
    if (parsed.data.newConversionBaseUnitsPerUnit) {
      const { error: convError } = await supabase
        .from("ingredient_unit_conversions")
        .upsert({ ingredient_id: ingredientId, unit: displayUnit, base_units_per_unit: parsed.data.newConversionBaseUnitsPerUnit }, { onConflict: "ingredient_id,unit" });
      if (convError) {
        logQueryError("addRecipeLine:conversionUpsert", convError);
        return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
      }
      conversions = [{ unit: displayUnit, baseUnitsPerUnit: parsed.data.newConversionBaseUnitsPerUnit }];
    } else {
      const { data: existingConversion, error: conversionLookupError } = await supabase
        .from("ingredient_unit_conversions")
        .select("base_units_per_unit")
        .eq("ingredient_id", ingredientId)
        .eq("unit", displayUnit)
        .maybeSingle();
      if (conversionLookupError) {
        logQueryError("addRecipeLine:conversionLookup", conversionLookupError);
        return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
      }
      if (!existingConversion) return { ok: false, error: `Define 1 ${displayUnit} for this ingredient first.` };
      conversions = [{ unit: displayUnit, baseUnitsPerUnit: Number(existingConversion.base_units_per_unit) }];
    }
  }

  const canonicalQuantity = toBaseUnitQuantity(displayUnit, parsed.data.displayQuantity, ingredientBaseUnit!, conversions);
  if (canonicalQuantity === null) return { ok: false, error: "Enter a valid quantity for this unit." };

  const { error } = await supabase
    .from("recipe_lines")
    .upsert(
      { menu_item_id: parsed.data.menuItemId, ingredient_id: ingredientId, quantity: canonicalQuantity, display_unit: displayUnit, display_quantity: parsed.data.displayQuantity },
      { onConflict: "menu_item_id,ingredient_id" },
    );
  if (error) {
    logQueryError("addRecipeLine:upsert", error);
    return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  }

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  revalidatePath("/");
  return { ok: true };
}

export async function deleteRecipeLine(menuItemId: string, ingredientId: string): Promise<ActionResult> {
  const businessId = await currentBusinessId();
  if (!businessId) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { data: menuItem, error: menuItemError } = await supabase.from("menu_items").select("id").eq("id", menuItemId).eq("business_id", businessId).single();
  if (menuItemError) logQueryError("deleteRecipeLine:menuItem", menuItemError);
  if (!menuItem) return { ok: false, error: "Item not found." };

  const { error } = await supabase.from("recipe_lines").delete().eq("menu_item_id", menuItemId).eq("ingredient_id", ingredientId);
  if (error) {
    logQueryError("deleteRecipeLine", error);
    return { ok: false, error: MENU_SAVE_FAILURE_MESSAGE };
  }

  revalidatePath("/menu");
  revalidatePath("/menu/manage");
  return { ok: true };
}
