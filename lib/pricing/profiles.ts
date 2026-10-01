import type { PricingCategory, PricingProfile } from "@/lib/calc/types";

export const COFFEE_SHOP_PROFILE = {
  businessType: "COFFEE_SHOP",
  targetProductCostPercent: 0.3,
  minimumProductCostPercent: 0.25,
  maximumProductCostPercent: 0.35,
  minimumPriceChangePercent: 0.05,
  minimumPriceChangeAmountCents: 25,
  reviewWindowDays: 90,
  roundingRule: { incrementCents: 25, mode: "nearest" },
  targetOperatingMargin: 0.15,
  businessAdjustmentCap: 1.15,
} as const;

export const MIN_COVERAGE_RATIO = 0.5;
export const MIN_ORDERS_IN_WINDOW = 200;
export const MIN_ITEM_UNITS_SOLD = 20;
export const MIN_CATEGORY_PEERS = 3;
export const CATEGORY_PRICE_OUTLIER_RATIO = 0.5;
export const CATEGORY_COST_PCT_OUTLIER_PP = 0.15;

export function getPricingProfile(category: PricingCategory): PricingProfile {
  return { ...COFFEE_SHOP_PROFILE, roundingRule: { ...COFFEE_SHOP_PROFILE.roundingRule }, category };
}
