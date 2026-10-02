import type { MenuItemCategoryCode } from "@/lib/constants";

/** The owner-facing "Item type" choices — plain language for the same internal `category` enum
 * used for pricing/analytics. An owner never sees `ESPRESSO_DRINK` or `SPECIALTY_DRINK`; they see
 * "Espresso / coffee drink" or "Other drink". `AUTOMATIC` has no internal category of its own —
 * it means "let `inferMenuItemCategory` decide", the same inference every item already gets when
 * no category is given. */
export const OWNER_ITEM_TYPES = [
  "AUTOMATIC",
  "ESPRESSO_COFFEE",
  "BREWED_COFFEE",
  "COLD_BREW",
  "TEA",
  "OTHER_DRINK",
  "BAKERY",
  "FOOD",
  "RETAIL",
] as const;

export type OwnerFacingItemType = (typeof OWNER_ITEM_TYPES)[number];

/** A clean 1:1 mapping onto the existing internal enum — adding a friendly name changes nothing
 * about the database, the pricing engine, or category-based analytics. */
export const OWNER_ITEM_TYPE_TO_CATEGORY: Record<Exclude<OwnerFacingItemType, "AUTOMATIC">, MenuItemCategoryCode> = {
  ESPRESSO_COFFEE: "ESPRESSO_DRINK",
  BREWED_COFFEE: "BREWED_COFFEE",
  COLD_BREW: "COLD_BREW",
  TEA: "TEA",
  OTHER_DRINK: "SPECIALTY_DRINK",
  BAKERY: "PASTRY",
  FOOD: "FOOD",
  RETAIL: "RETAIL",
};

const CATEGORY_TO_OWNER_ITEM_TYPE: Record<MenuItemCategoryCode, Exclude<OwnerFacingItemType, "AUTOMATIC">> = Object.fromEntries(
  (Object.entries(OWNER_ITEM_TYPE_TO_CATEGORY) as [Exclude<OwnerFacingItemType, "AUTOMATIC">, MenuItemCategoryCode][]).map(([type, category]) => [category, type]),
) as Record<MenuItemCategoryCode, Exclude<OwnerFacingItemType, "AUTOMATIC">>;

/** The friendly type for an item's current (already-saved) internal category — used to preselect
 * Product Edit's "Item type" field. This never returns "AUTOMATIC": the database only ever holds
 * a concrete category, so the edit form shows the type that category actually corresponds to,
 * not a claim about whether it was auto-inferred or chosen. The owner can still switch it back to
 * Automatic explicitly if they want this item re-inferred on save. */
export function categoryToOwnerItemType(category: MenuItemCategoryCode): Exclude<OwnerFacingItemType, "AUTOMATIC"> {
  return CATEGORY_TO_OWNER_ITEM_TYPE[category];
}
