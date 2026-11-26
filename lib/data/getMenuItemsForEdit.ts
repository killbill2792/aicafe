import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import { getTranslations } from "next-intl/server";
import { displayPantryStarterName } from "@/lib/menu/pantryStarter";
import { visiblePricedMenuItems } from "@/lib/menu/pricedMenuVisibility";
import { readMenuCatalogRows } from "./menuCatalog.server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { type ProductCostSource, type RecipeCostStatus } from "@/lib/calc";
import type { MenuItemCategoryCode } from "@/lib/constants";
import { logQueryError, MENU_LOAD_FAILURE_MESSAGE } from "./queryError";
import {readProductCosts} from "./productCosts.server";

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
  /** Optional per-size order; older lines fall back to ingredient UUID. */
  sortOrder?: number | null;
  costCents: number | null;
  priceSource: "manual" | "receipt" | "statement" | "invoice" | null;
};

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
  /** Resolved cost: complete recipe first, otherwise owner-entered total fallback. */
  ingredientsCostCents: number | null;
  costStatus: RecipeCostStatus;
  costSource?: ProductCostSource | null;
  recipeCostCents?: number | null;
  recipeCostStatus?: RecipeCostStatus;
  ownerTotalCostCents?: number | null;
  ownerTotalCostStatus?: "confirmed" | "estimated" | null;
  ownerTotalCostSource?: "owner_manual" | "imported" | null;
  costDifferenceCents?: number | null;
  comboCostEstimated?: boolean;
  missingCostIngredientNames: string[];
};

export type IngredientOption = { id: string; name: string; baseUnit: "g" | "ml" | "each" };

/** Everything the "manage menu" screen needs: every menu item (active and inactive) with its
 * current recipe, plus the full ingredient list for the "pick an existing ingredient" dropdown. */
export async function getMenuItemsForEdit(explicit?:{client:SupabaseClient;businessId:string}): Promise<{ items: MenuItemForEdit[]; ingredients: IngredientOption[] }> {
  if (!isSupabaseConfigured()) return { items: [], ingredients: [] };
  const supabase = explicit?.client ?? await createServerSupabaseClient();
  const user = explicit ? null : (await supabase.auth.getUser()).data.user;
  if (!explicit && !user) return { items: [], ingredients: [] };
  const businessId = explicit?.businessId ?? await getActiveBusinessId(user!.id);

  const [catalogRows, ingredientsResult] = await Promise.all([
    readMenuCatalogRows(supabase, businessId),
    supabase.from("ingredients").select("id, name, base_unit, starter_key").eq("business_id", businessId).is("archived_at",null).order("name"),
  ]);
  if (ingredientsResult.error) {
    logQueryError("getMenuItemsForEdit:ingredients", ingredientsResult.error);
    throw new Error(MENU_LOAD_FAILURE_MESSAGE);
  }
  const items=visiblePricedMenuItems(catalogRows);
  const ingredients=ingredientsResult.data;
  const costs=await readProductCosts(supabase,businessId,items.map(i=>i.id));

  const translate = explicit ? null : await getTranslations("Pantry.starters");
  const localized = (name: string, key: string | null | undefined) =>
    translate ? displayPantryStarterName(name, key, (k) => translate(k as never)) : name;
  const ingredientOptions: IngredientOption[] = (ingredients ?? []).map((i) => ({
    id: i.id,
    name: localized(i.name, i.starter_key),
    baseUnit: i.base_unit as "g" | "ml" | "each",
  }));

  const menuItems:MenuItemForEdit[]=items.map(item=>{
    const cost=costs.get(item.id)!;
    const recipeWithCosts:RecipeLineForEdit[]=cost.recipe.flatMap(line=>
      line.ingredientName&&line.baseUnit?[{
        ingredientId:line.ingredientId,ingredientName:localized(line.ingredientName,line.starterKey),
        baseUnit:line.baseUnit,quantity:line.quantity,displayUnit:line.displayUnit,
        displayQuantity:line.displayQuantity,sortOrder:line.sortOrder,costCents:line.costCents,
        priceSource:line.priceSource,
      }]:[]);
    return {
      id: item.id,
      name: item.name,
      baseName: item.base_name ?? item.name,
      sizeLabel: item.size_label ?? null,
      priceCents: Number(item.price_cents),
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
      costSource: cost.source,
      recipeCostCents: cost.recipeCostCents,
      recipeCostStatus: cost.recipeStatus,
      ownerTotalCostCents: cost.ownerTotalCostCents,
      ownerTotalCostStatus: cost.ownerTotalCostStatus,
      ownerTotalCostSource: cost.ownerTotalCostSource,
      costDifferenceCents: cost.differenceCents,
      comboCostEstimated:cost.source==="combo"?cost.estimated:undefined,
      missingCostIngredientNames: recipeWithCosts.filter(line=>line.costCents===null).map(line=>line.ingredientName),
    };
  });


  return {items:menuItems,ingredients:ingredientOptions};
}
