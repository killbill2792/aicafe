import { describe, expect, it } from "vitest";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { applyRounding } from "./pricingRounding";
import { businessAdjustmentFactor, businessEconomics, monthlyProcessingFeesForWindow } from "./pricingBusiness";
import { suggestPrice, type SuggestPriceInput } from "./pricingEngine";

const base = (overrides: Partial<SuggestPriceInput> = {}): SuggestPriceInput => ({
  productCostCents: 160, currentPriceCents: 500, recipeStatus: "READY", profile: getPricingProfile("ESPRESSO_DRINK"),
  posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 },
  economics: null, categoryPeers: null, ...overrides,
});

describe("pricing engine", () => {
  it("never recommends lowering an established healthy price just to hit the benchmark", () => {
    const result = suggestPrice(base({
      productCostCents: 600,
      currentPriceCents: 2300,
      recipeStatus: "READY",
      profile: getPricingProfile("FOOD"),
    }));
    expect(result.recommendedPriceCents).toBe(2300);
    expect(result.status).toBe("KEEP_CURRENT_PRICE");
  });

  const establishedSignal = { daysWithSalesInWindow: 80, windowDays: 90, totalOrdersInWindow: 1000, itemUnitsSoldInWindow: 100, monthlyRevenueCents: 100_000 };

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
    const economics = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 25_000, monthlyStaffCostCents: 25_000, monthlyOperatingCostCents: 20_000, monthlyProcessingFeesCents: 3_000 };
    expect(businessEconomics(economics)).toMatchObject({ totalMonthlyCostCents: 73_000, operatingSurplusCents: 27_000, operatingMargin: 0.27 });
    const result = suggestPrice(base({ posSignal: establishedSignal, economics }));
    expect(result.calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result.businessAdjustmentFactor).toBe(1);
    expect(result.confidence).toBe("HIGH");
  });

  it("caps a severe shortfall and asks for review rather than auto-applying", () => {
    const economics = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 50_000, monthlyStaffCostCents: 25_000, monthlyOperatingCostCents: 20_000, monthlyProcessingFeesCents: 10_000 };
    const result = suggestPrice(base({ posSignal: establishedSignal, economics }));
    expect(result.businessAdjustmentFactor).toBe(1.15);
    expect(result.warnings).toContain("BUSINESS_ADJUSTMENT_CAPPED");
    expect(result.status).toBe("REVIEW_PRICE");
  });

  it("returns the current price inside the stability threshold", () => expect(suggestPrice(base({ currentPriceCents: 525 })).recommendedPriceCents).toBe(525));
  it("preserves the former round-up behavior as an available profile rule", () => expect(applyRounding(160 / 0.3, { incrementCents: 25, mode: "up" })).toBe(550));
  it("never lets the business adjustment exceed its safety cap", () => expect(businessAdjustmentFactor({ totalMonthlyCostCents: 140_000, operatingSurplusCents: -40_000, operatingMargin: -0.4 }, 100_000, 0.15, 1.15)).toEqual({ businessAdjustmentFactor: 1.15, cappedForReview: true }));

  describe("processing-fee economics", () => {
    it("scales actual fees from the 90-day pricing window to a 30-day monthly value", () => {
      expect(monthlyProcessingFeesForWindow([7_000, 7_000, 7_000], 90)).toBe(7_000);
      expect(monthlyProcessingFeesForWindow([], 90)).toBe(0);
    });

    it("counts processing fees exactly once in total costs", () => {
      const withoutFees = businessEconomics({ monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 25_000, monthlyStaffCostCents: 30_000, monthlyOperatingCostCents: 25_000, monthlyProcessingFeesCents: 0 });
      const withFees = businessEconomics({ monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 25_000, monthlyStaffCostCents: 30_000, monthlyOperatingCostCents: 25_000, monthlyProcessingFeesCents: 3_000 });
      expect(withFees.totalMonthlyCostCents - withoutFees.totalMonthlyCostCents).toBe(3_000);
      expect(withoutFees.operatingSurplusCents - withFees.operatingSurplusCents).toBe(3_000);
    });

    it("increases the factor when processing fees create an operating-margin shortfall", () => {
      const economics = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 25_000, monthlyStaffCostCents: 30_000, monthlyOperatingCostCents: 28_000, monthlyProcessingFeesCents: 5_000 };
      const result = suggestPrice(base({ posSignal: establishedSignal, economics }));
      expect(businessEconomics(economics).operatingMargin).toBe(0.12);
      expect(result.businessAdjustmentFactor).toBe(1.03);
      expect(result.calculatedSuggestedPriceCents).toBe(550);
      expect(result.warnings).not.toContain("BUSINESS_ADJUSTMENT_CAPPED");
    });

    it("caps a raw factor above 1.15 and emits the review warning", () => {
      const economics = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 35_000, monthlyStaffCostCents: 35_000, monthlyOperatingCostCents: 25_000, monthlyProcessingFeesCents: 10_000 };
      const result = suggestPrice(base({ posSignal: establishedSignal, economics }));
      // Surplus is -5,000, so raw factor is 1 + (15,000 - -5,000) / 100,000 = 1.20.
      expect(result.businessAdjustmentFactor).toBe(1.15);
      expect(result.businessAdjustmentFactor).toBeLessThanOrEqual(1.15);
      expect(result.warnings).toContain("BUSINESS_ADJUSTMENT_CAPPED");
      expect(result.calculatedSuggestedPriceCents).toBe(625);
    });

    it("moves a representative suggestion only after actual fees create a shortfall", () => {
      const common = { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 25_000, monthlyStaffCostCents: 30_000, monthlyOperatingCostCents: 28_000 };
      const before = suggestPrice(base({ currentPriceCents: 0, posSignal: establishedSignal, economics: { ...common, monthlyProcessingFeesCents: 0 } }));
      const after = suggestPrice(base({ currentPriceCents: 0, posSignal: establishedSignal, economics: { ...common, monthlyProcessingFeesCents: 5_000 } }));
      expect(before.businessAdjustmentFactor).toBe(1);
      expect(before.calculatedSuggestedPriceCents).toBe(525);
      expect(after.businessAdjustmentFactor).toBe(1.03);
      expect(after.calculatedSuggestedPriceCents).toBe(550);
    });

    it("falls back to a useful benchmark and reports missing processing fees when economics are incomplete", () => {
      const result = suggestPrice(base({
        currentPriceCents: 0,
        posSignal: establishedSignal,
        economics: null,
        businessEconomicsMissingInputs: ["processingFees"],
      }));
      expect(result.calculationMode).toBe("BENCHMARK");
      expect(result.recommendedPriceCents).toBe(525);
      expect(result.dataQuality.missingInputs).toContain("processingFees");
      expect(result.businessAdjustmentFactor).toBe(1);
    });
  });

  // Regression coverage for the "Suggested: $0.00" production bug (2026-10-01): a legitimately
  // priced recipe with a tiny fractional-cent cost got crushed to exactly $0.00 by nearest-25¢
  // rounding, and nothing distinguished that from "no valid price." These lock in the fix.
  describe("fractional cost and the never-$0.00 invariant", () => {
    it("handles a complete recipe with a fractional-cent intermediate cost (the exact production case: 3ml milk at $0.50/ml = 1.5¢)", () => {
      const result = suggestPrice(base({ productCostCents: 1.5, currentPriceCents: 3000 }));
      expect(result.status).not.toBe("PRICE_UNAVAILABLE");
      expect(result.recommendedPriceCents).toBe(25); // 1.5/0.30 = 5¢ raw, rounds to nearest 25¢ = 0 -> floored to one increment
      expect(result.recommendedPriceCents).not.toBe(0);
    });

    it("treats a complete, normally-priced recipe as before (no regression from the fractional-cost fix)", () => {
      const result = suggestPrice(base({ productCostCents: 160, currentPriceCents: 0 }));
      expect(result.status).toBe("NEW_PRICE");
      expect(result.recommendedPriceCents).toBe(525);
    });

    it("returns PRICE_UNAVAILABLE, not a numeric zero, for a missing ingredient cost", () => {
      const result = suggestPrice(base({ recipeStatus: "MISSING_INGREDIENT_COST", productCostCents: 0 }));
      expect(result.status).toBe("PRICE_UNAVAILABLE");
      expect(result.recommendedPriceCents).toBeNull();
      expect(result.calculatedSuggestedPriceCents).toBeNull();
      expect(result.baselinePriceCents).toBeNull();
      expect(result.productCostCents).toBeNull();
    });

    it("returns PRICE_UNAVAILABLE for no recipe at all", () => {
      const result = suggestPrice(base({ recipeStatus: "NO_RECIPE", productCostCents: 0 }));
      expect(result.status).toBe("PRICE_UNAVAILABLE");
      expect(result.recommendedPriceCents).toBeNull();
    });

    it("returns PRICE_UNAVAILABLE for a recipe that priced to an actual zero/invalid cost, not READY-with-zero", () => {
      const result = suggestPrice(base({ recipeStatus: "READY", productCostCents: 0 }));
      expect(result.status).toBe("PRICE_UNAVAILABLE");
      expect(result.recommendedPriceCents).toBeNull();
    });

    it("stays PRICE_UNAVAILABLE even when a current price already exists — never falls back to REVIEW_PRICE/KEEP_CURRENT_PRICE with a null or zero number", () => {
      const result = suggestPrice(base({ recipeStatus: "MISSING_INGREDIENT_COST", productCostCents: 0, currentPriceCents: 3000 }));
      expect(result.status).toBe("PRICE_UNAVAILABLE");
      expect(result.currentPriceCents).toBe(3000); // still reported — just not used to compute a fake recommendation
      expect(result.recommendedPriceCents).toBeNull();
    });

    it("never produces a numeric $0.00 recommendation across a sweep of small positive costs", () => {
      for (const productCostCents of [0.1, 0.5, 1, 1.5, 2, 4, 6, 10, 12]) {
        const result = suggestPrice(base({ productCostCents, currentPriceCents: 0 }));
        expect(result.status).not.toBe("PRICE_UNAVAILABLE");
        expect(result.recommendedPriceCents).toBeGreaterThan(0);
      }
    });
  });
});
