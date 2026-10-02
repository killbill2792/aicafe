import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";

/** The owner-facing pricing status for ONE menu item (one size), in plain language, derived
 * entirely from data the pricing engine already computes (`costStatus`, `pricing.status`,
 * `pricing.recommendedPriceCents` vs `pricing.currentPriceCents`) — no new calculation. This is
 * the single source of truth every other piece of pricing copy in Menu reads from: the catalog
 * chip, the grouped-product status, and the product detail Overview all call this one function so
 * they can never disagree about the same item. */
export type ItemPricingStatus =
  | { kind: "incomplete_recipe" }
  | { kind: "price_unavailable" }
  | { kind: "keep" }
  | { kind: "low"; suggestedPriceCents: number }
  | { kind: "high"; suggestedPriceCents: number };

export function getItemPricingStatus(item: Pick<MenuControlItem, "costStatus" | "pricing">): ItemPricingStatus {
  if (item.costStatus !== "READY") return { kind: "incomplete_recipe" };
  if (!item.pricing || item.pricing.status === "PRICE_UNAVAILABLE" || item.pricing.recommendedPriceCents === null) {
    return { kind: "price_unavailable" };
  }
  if (item.pricing.status === "KEEP_CURRENT_PRICE") return { kind: "keep" };
  // REVIEW_PRICE (and the practically-unreachable NEW_PRICE, for a current price of $0) both
  // carry a real recommendedPriceCents — "low"/"high" is just which way that number points
  // relative to what the owner charges today, not a new calculation.
  const suggestedPriceCents = item.pricing.recommendedPriceCents;
  return suggestedPriceCents >= item.pricing.currentPriceCents ? { kind: "low", suggestedPriceCents } : { kind: "high", suggestedPriceCents };
}

/** A product's pricing is "healthy" (the simple good/bad split the catalog and detail chips use)
 * only when the owner's current price already matches the recommendation. Every other state
 * (incomplete recipe, no usable price, or a price worth reviewing either direction) needs
 * attention. */
export function isPricingHealthy(item: Pick<MenuControlItem, "costStatus" | "pricing">): boolean {
  return getItemPricingStatus(item).kind === "keep";
}

/** The owner-facing pricing status for a GROUPED product (one or more sizes). Missing data
 * (no recipe, or a recipe with no priced cost) always takes priority over a pricing-review
 * message — an owner can't act on "price may be low" for a size we don't even have a cost for.
 * When more than one size needs review, this deliberately does NOT fabricate one suggested price
 * for the whole product; the owner opens the product to see each size on its own. */
export type GroupedPricingStatus =
  | { kind: "all_healthy" }
  | { kind: "needs_review_one"; sizeLabel: string | null; direction: "low" | "high"; suggestedPriceCents: number }
  | { kind: "needs_review_many"; count: number }
  | { kind: "missing_recipe_one"; sizeLabel: string | null }
  | { kind: "missing_data"; count: number };

function isDataIncomplete(item: Pick<MenuControlItem, "costStatus" | "pricing">): boolean {
  const status = getItemPricingStatus(item);
  return status.kind === "incomplete_recipe" || status.kind === "price_unavailable";
}

function computeGroupedPricingStatus(members: MenuControlItem[]): GroupedPricingStatus {
  const incomplete = members.filter(isDataIncomplete);
  if (incomplete.length > 0) {
    // Only called out by name when it's the one simple case: exactly one size, and that size has
    // no recipe at all. Anything else (missing ingredient cost, or more than one size) gets a
    // generic count instead of guessing which size matters most.
    if (incomplete.length === 1 && incomplete[0].costStatus === "NO_RECIPE") {
      return { kind: "missing_recipe_one", sizeLabel: incomplete[0].sizeLabel };
    }
    return { kind: "missing_data", count: incomplete.length };
  }

  const needingReview: { sizeLabel: string | null; direction: "low" | "high"; suggestedPriceCents: number }[] = [];
  for (const member of members) {
    const status = getItemPricingStatus(member);
    if (status.kind === "low" || status.kind === "high") {
      needingReview.push({ sizeLabel: member.sizeLabel, direction: status.kind, suggestedPriceCents: status.suggestedPriceCents });
    }
  }
  if (needingReview.length === 0) return { kind: "all_healthy" };
  if (needingReview.length === 1) {
    const only = needingReview[0];
    return { kind: "needs_review_one", sizeLabel: only.sizeLabel, direction: only.direction, suggestedPriceCents: only.suggestedPriceCents };
  }
  return { kind: "needs_review_many", count: needingReview.length };
}

export type SizePriceRange = { minCents: number; maxCents: number; allSame: boolean };

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
  isSingleSize: boolean;
  priceRange: SizePriceRange;
  pricingStatus: GroupedPricingStatus;
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
    const prices = members.map((m) => m.priceCents);
    const minCents = Math.min(...prices);
    const maxCents = Math.max(...prices);
    return {
      key,
      baseName: representativeItem.baseName,
      menuGroup: representativeItem.menuGroup,
      active: representativeItem.active,
      representativeItem,
      sizeLabels: members.map((m) => m.sizeLabel).filter((label): label is string => Boolean(label)),
      isSingleSize: members.length === 1,
      priceRange: { minCents, maxCents, allSame: minCents === maxCents },
      pricingStatus: computeGroupedPricingStatus(members),
      memberIds: members.map((m) => m.id),
    };
  });
}
