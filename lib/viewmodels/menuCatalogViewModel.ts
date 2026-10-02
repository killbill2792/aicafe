import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";

/** A product's pricing is "healthy" (the simple good/bad split the catalog and detail chips use)
 * only when the recipe is complete, a recommended price exists, and the owner's current price
 * already matches it — every other state (incomplete recipe, no usable price, or a price worth
 * reviewing) counts as needing attention. Single source of truth so the per-item chip and the
 * grouped-product status below can never disagree about the same item. */
export function isPricingHealthy(item: Pick<MenuControlItem, "costStatus" | "pricing">): boolean {
  if (item.costStatus !== "READY") return false;
  if (!item.pricing || item.pricing.status === "PRICE_UNAVAILABLE" || item.pricing.recommendedPriceCents === null) return false;
  return item.pricing.status === "KEEP_CURRENT_PRICE";
}

export type GroupedMenuCatalogItem = {
  /** Stable React key — baseName alone isn't enough since an active "Latte" and an archived
   * "Latte" must never merge into one row. */
  key: string;
  baseName: string;
  menuGroup: string | null;
  active: boolean;
  /** The size this row links to when tapped — the cheapest member, chosen deterministically (tie
   * broken by id) so the same product always opens the same size. The product detail page's own
   * Sizes tab remains where every size is actually managed. */
  representativeItem: MenuControlItem;
  /** Every size label in the group, cheapest first, blanks dropped — e.g. ["12 oz", "16 oz"]. */
  sizeLabels: string[];
  /** The lowest price among this group's sizes — what "from $X" shows. Equals
   * representativeItem.priceCents by construction. */
  fromPriceCents: number;
  isSingleSize: boolean;
  /** Conservative: true the moment any size in the group needs attention, even if others don't —
   * an owner should never see "all good" while one size is actually mispriced. */
  needsAttention: boolean;
  memberIds: string[];
};

function compareByPriceThenId(a: MenuControlItem, b: MenuControlItem): number {
  return a.priceCents - b.priceCents || a.id.localeCompare(b.id);
}

/** Groups menu items that are really the same product at different sizes (same `baseName`) into
 * one owner-facing row, the way the approved Menu reference shows one "Latte" row instead of
 * duplicate rows per size. Sizes stay separate `menu_items` rows in the database and in every
 * calculation — this only reshapes an already-loaded list for display, so it takes whatever list
 * the caller has already filtered (search, menu-group tab, archived tab) and groups just that. */
export function groupMenuCatalogItems(items: MenuControlItem[]): GroupedMenuCatalogItem[] {
  const order: string[] = [];
  const membersByKey = new Map<string, MenuControlItem[]>();
  for (const item of items) {
    // Active and archived items with the same baseName must never land in the same row.
    const key = `${item.active ? "active" : "archived"}::${item.baseName}`;
    const members = membersByKey.get(key);
    if (members) members.push(item);
    else {
      membersByKey.set(key, [item]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const members = [...membersByKey.get(key)!].sort(compareByPriceThenId);
    const representativeItem = members[0];
    return {
      key,
      baseName: representativeItem.baseName,
      menuGroup: representativeItem.menuGroup,
      active: representativeItem.active,
      representativeItem,
      sizeLabels: members.map((m) => m.sizeLabel).filter((label): label is string => Boolean(label)),
      fromPriceCents: representativeItem.priceCents,
      isSingleSize: members.length === 1,
      needsAttention: members.some((m) => !isPricingHealthy(m)),
      memberIds: members.map((m) => m.id),
    };
  });
}
