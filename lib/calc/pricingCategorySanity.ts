import { CATEGORY_COST_PCT_OUTLIER_PP, CATEGORY_PRICE_OUTLIER_RATIO } from "@/lib/pricing/profiles";
import type { CategoryPeerStats, PricingWarningCode } from "./types";

export function categorySanityWarnings(priceCents: number, costPercent: number, peers: CategoryPeerStats): PricingWarningCode[] {
  if (!peers) return [];
  const warnings: PricingWarningCode[] = [];
  if (peers.medianPriceCents > 0 && Math.abs(priceCents - peers.medianPriceCents) / peers.medianPriceCents > CATEGORY_PRICE_OUTLIER_RATIO) warnings.push("CATEGORY_PRICE_OUTLIER");
  if (Math.abs(costPercent - peers.medianProductCostPercent) > CATEGORY_COST_PCT_OUTLIER_PP) warnings.push("CATEGORY_COST_PERCENT_OUTLIER");
  return warnings;
}
