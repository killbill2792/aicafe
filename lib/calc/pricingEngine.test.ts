import { describe, expect, it } from "vitest";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { applyRounding } from "./pricingRounding";
import { businessAdjustmentFactor, businessEconomics } from "./pricingBusiness";
import { suggestPrice, type SuggestPriceInput } from "./pricingEngine";

const base = (overrides: Partial<SuggestPriceInput> = {}): SuggestPriceInput => ({
  productCostCents: 160, currentPriceCents: 500, hasCompleteRecipe: true, profile: getPricingProfile("ESPRESSO_DRINK"),
  posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 },
  economics: null, categoryPeers: null, ...overrides,
});

describe("pricing engine", () => {
  it("works with no AI configuration and emits integer-cent structured output", () => {
    const previous = process.env.AI_PROVIDER; delete process.env.AI_PROVIDER;
    const result = suggestPrice(base({ currentPriceCents: 0 }));
    expect(result.calculationMode).toBe("BENCHMARK");
    expect(result.confidence).toBe("MEDIUM");
    expect(result.recommendedPriceCents).toBe(525);
    expect(Number.isInteger(result.recommendedPriceCents)).toBe(true);
    expect(result.dataQuality.estimatedInputs).toContain("coffeeShopPricingProfile");
    process.env.AI_PROVIDER = previous;
  });

  it("keeps an established healthy cafe at factor 1 and uses one cost composition", () => {
    const economics = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 25_000, monthlyStaffCostCents: 25_000, monthlyOperatingCostCents: 20_000 };
    expect(businessEconomics(economics)).toMatchObject({ totalMonthlyCostCents: 70_000, operatingSurplusCents: 30_000 });
    const result = suggestPrice(base({ posSignal: { daysWithSalesInWindow: 80, windowDays: 90, totalOrdersInWindow: 1000, itemUnitsSoldInWindow: 100, monthlyRevenueCents: 100_000 }, economics }));
    expect(result.calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result.businessAdjustmentFactor).toBe(1);
    expect(result.confidence).toBe("HIGH");
  });

  it("caps a severe shortfall and asks for review rather than auto-applying", () => {
    const economics = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 50_000, monthlyStaffCostCents: 45_000, monthlyOperatingCostCents: 30_000 };
    const result = suggestPrice(base({ posSignal: { daysWithSalesInWindow: 80, windowDays: 90, totalOrdersInWindow: 1000, itemUnitsSoldInWindow: 100, monthlyRevenueCents: 100_000 }, economics }));
    expect(result.businessAdjustmentFactor).toBe(1.15);
    expect(result.warnings).toContain("BUSINESS_ADJUSTMENT_CAPPED");
    expect(result.status).toBe("REVIEW_PRICE");
  });

  it("returns the current price inside the stability threshold", () => expect(suggestPrice(base({ currentPriceCents: 525 })).recommendedPriceCents).toBe(525));
  it("preserves the former round-up behavior as an available profile rule", () => expect(applyRounding(160 / 0.3, { incrementCents: 25, mode: "up" })).toBe(550));
  it("never lets the business adjustment exceed its safety cap", () => expect(businessAdjustmentFactor({ totalMonthlyCostCents: 140_000, operatingSurplusCents: -40_000, operatingMargin: -0.4 }, 100_000, 0.15, 1.15)).toEqual({ businessAdjustmentFactor: 1.15, cappedForReview: true }));
});
