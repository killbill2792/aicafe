import { describe, expect, it } from "vitest";
import { buildPricingViewModel } from "./pricingViewModel";
import type { PricingBusinessInput, PricingItemInput } from "@/lib/data/getPricingInputs";

const item: PricingItemInput = {
  id: "latte",
  name: "Latte",
  category: "ESPRESSO_DRINK",
  currentPriceCents: 0,
  productCostCents: 160,
  recipeStatus: "READY",
  unitsSoldInWindow: 100,
};

const business: PricingBusinessInput = {
  windowDays: 90,
  daysWithSalesInWindow: 80,
  totalOrdersInWindow: 1_000,
  monthlyRevenueCents: 100_000,
  monthlyStaffCostCents: 30_000,
  monthlyOperatingCostCents: 28_000,
  monthlyVariableProductCostCents: 25_000,
  monthlyProcessingFeesCents: 5_000,
  processingFeesStatus: "actual",
};

describe("pricing processing-fee quality", () => {
  it("preserves business-adjusted pricing when processing fees are actual", () => {
    const result = buildPricingViewModel({ items: [item], business })[0].result;
    expect(result.calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result.businessAdjustmentFactor).toBe(1.03);
    expect(result.dataQuality.missingInputs).not.toContain("processingFees");
  });

  it("does not treat missing processing fees as actual zero and keeps benchmark pricing useful", () => {
    const result = buildPricingViewModel({ items: [item], business: { ...business, monthlyProcessingFeesCents: 0, processingFeesStatus: "missing" } })[0].result;
    expect(result.calculationMode).toBe("BENCHMARK");
    expect(result.businessAdjustmentFactor).toBe(1);
    expect(result.recommendedPriceCents).toBeGreaterThan(0);
    expect(result.dataQuality.missingInputs).toContain("processingFees");
  });

  it("reserves estimated fee provenance without treating it as missing", () => {
    const result = buildPricingViewModel({ items: [item], business: { ...business, processingFeesStatus: "estimated" } })[0].result;
    expect(result.calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result.dataQuality.estimatedInputs).toContain("processingFees");
  });
});
