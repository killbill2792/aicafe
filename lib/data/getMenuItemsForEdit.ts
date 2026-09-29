import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

export type RecipeLineForEdit = {
  ingredientId: string;
  ingredientName: string;
  baseUnit: "g" | "ml" | "each";
  quantity: number;
};

export type MenuItemForEdit = {
  id: string;
  name: string;
  priceCents: number;
  prepSeconds: number;
  category: "drink" | "food";
  active: boolean;
  recipe: RecipeLineForEdit[];
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

  const [{ data: items }, { data: ingredients }] = await Promise.all([
    supabase.from("menu_items").select("id, name, price_cents, prep_seconds, category, is_active").eq("business_id", businessId).order("name"),
    supabase.from("ingredients").select("id, name, base_unit").eq("business_id", businessId).order("name"),
  ]);

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

  const menuItems: MenuItemForEdit[] = (items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    priceCents: item.price_cents ?? 0,
    prepSeconds: item.prep_seconds,
    category: (item.category === "food" ? "food" : "drink") as "drink" | "food",
    active: item.is_active,
    recipe: (recipeByItem.get(item.id) ?? []).sort((a, b) => a.ingredientName.localeCompare(b.ingredientName)),
  }));

  return { items: menuItems, ingredients: ingredientOptions };
}
