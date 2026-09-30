import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { itemIngredientCostCents } from "@/lib/calc";

export type RecipeLineForEdit = {
  ingredientId: string;
  ingredientName: string;
  baseUnit: "g" | "ml" | "each";
  quantity: number;
};

export type MenuItemForEdit = {
  id: string;
  name: string;
  baseName: string;
  sizeLabel: string | null;
  priceCents: number;
  prepSeconds: number;
  category: "drink" | "food";
  active: boolean;
  recipe: RecipeLineForEdit[];
  /** Today's priced ingredient cost for this item's current recipe — 0 when the recipe has no
   * ingredients yet, or none of them have a priced cost. Powers the "suggested price" hint. */
  ingredientsCostCents: number;
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

  const [{ data: items }, { data: ingredients }, { data: business }] = await Promise.all([
    supabase
      .from("menu_items")
      .select("id, name, base_name, size_label, price_cents, prep_seconds, category, is_active")
      .eq("business_id", businessId)
      .order("name"),
    supabase.from("ingredients").select("id, name, base_unit").eq("business_id", businessId).order("name"),
    supabase.from("businesses").select("timezone").eq("id", businessId).single(),
  ]);
  const todayDateStr = formatInTimeZone(new Date(), business?.timezone ?? "America/Los_Angeles", "yyyy-MM-dd");

  const itemIds = (items ?? []).map((i) => i.id);
  const { data: recipeLines } =
    itemIds.length > 0
      ? await supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity, ingredients(name, base_unit)").in("menu_item_id", itemIds)
      : { data: [] };

  const ingredientOptions: IngredientOption[] = (ingredients ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    baseUnit: i.base_unit as "g" | "ml" | "each",
  }));

  const recipeByItem = new Map<string, RecipeLineForEdit[]>();
  for (const row of recipeLines ?? []) {
    const ing = row.ingredients as unknown as { name: string; base_unit: string } | { name: string; base_unit: string }[] | null;
    const ingRow = Array.isArray(ing) ? ing[0] : ing;
    if (!ingRow) continue;
    const list = recipeByItem.get(row.menu_item_id) ?? [];
    list.push({ ingredientId: row.ingredient_id, ingredientName: ingRow.name, baseUnit: ingRow.base_unit as "g" | "ml" | "each", quantity: Number(row.quantity) });
    recipeByItem.set(row.menu_item_id, list);
  }

  // Latest priced-as-of-today cost per ingredient — same "ascending order, last write wins"
  // pattern getMenuItemSnapshots (lib/data/snapshot.server.ts) already uses for the read-only
  // Menu screen, reused here so the editor's "suggested price" is grounded in the same number.
  const recipeIngredientIds = [...new Set((recipeLines ?? []).map((r) => r.ingredient_id))];
  const { data: priceRows } =
    recipeIngredientIds.length > 0
      ? await supabase
          .from("ingredient_prices")
          .select("ingredient_id, effective_from, cost_per_base_unit_micros")
          .in("ingredient_id", recipeIngredientIds)
          .lte("effective_from", todayDateStr)
          .order("effective_from", { ascending: true })
      : { data: [] };
  const latestPriceMicros: Record<string, number> = {};
  for (const row of priceRows ?? []) {
    latestPriceMicros[row.ingredient_id] = row.cost_per_base_unit_micros;
  }

  const menuItems: MenuItemForEdit[] = (items ?? []).map((item) => {
    const recipe = (recipeByItem.get(item.id) ?? []).sort((a, b) => a.ingredientName.localeCompare(b.ingredientName));
    return {
      id: item.id,
      name: item.name,
      baseName: item.base_name ?? item.name,
      sizeLabel: item.size_label ?? null,
      priceCents: item.price_cents ?? 0,
      prepSeconds: item.prep_seconds,
      category: (item.category === "food" ? "food" : "drink") as "drink" | "food",
      active: item.is_active,
      recipe,
      ingredientsCostCents: itemIngredientCostCents(
        recipe.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity })),
        latestPriceMicros,
      ),
    };
  });

  return { items: menuItems, ingredients: ingredientOptions };
}
