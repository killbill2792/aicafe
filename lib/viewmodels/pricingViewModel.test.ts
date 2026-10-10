import { describe, expect, it } from "vitest";
import { buildPricingViewModel } from "./pricingViewModel";
import type { PricingBusinessInput, PricingItemInput } from "@/lib/data/getPricingInputs";

const item: PricingItemInput = {
  id: "latte",
  name: "Latte",
  category: "ESPRESSO_DRINK",
  currentPriceCents: 0,
  productCostCents: 160,
  productCostStatus: "READY",
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
  targetOperatingMargin: 0.15,
  targetOperatingMarginStatus: "confirmed",
  payrollTaxRateStatus: "confirmed",
  payrollCostsStatus: "actual",
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

  it("keeps Profit Goal simulator targets separate from operational Menu/Alex pricing", () => {
    const lowerTarget = buildPricingViewModel({
      items: [item],
      business: { ...business, targetOperatingMargin: 0.10 },
    })[0].result;
    const higherTarget = buildPricingViewModel({
      items: [item],
      business: { ...business, targetOperatingMargin: 0.40 },
    })[0].result;

    expect(lowerTarget.businessAdjustmentFactor).toBe(1.03);
    expect(higherTarget.businessAdjustmentFactor).toBe(1.03);
    expect(lowerTarget.recommendedPriceCents).toBe(higherTarget.recommendedPriceCents);
  });

  it("marks payroll assumptions as estimated without treating the simulator target as an operational input", () => {
    const result = buildPricingViewModel({
      items: [item],
      business: {
        ...business,
        targetOperatingMarginStatus: "default",
        payrollTaxRateStatus: "estimated",
        payrollCostsStatus: "estimated",
      },
    })[0].result;
    expect(result.dataQuality.estimatedInputs).toContain("payrollBurden");
    expect(result.dataQuality.estimatedInputs).not.toContain("targetOperatingMargin");
  });

  it("ignores a legacy saved 0% target in operational pricing", () => {
    const result = buildPricingViewModel({
      items: [item],
      business: { ...business, targetOperatingMargin: 0 },
    })[0].result;
    expect(result.businessAdjustmentFactor).toBe(1.03);
  });

  it("does not let owner-estimated fees substitute for real transaction history", () => {
    const result = buildPricingViewModel({
      items: [item],
      business: { ...business, totalOrdersInWindow: 0, processingFeesStatus: "estimated" },
    })[0].result;
    expect(result.calculationMode).toBe("BENCHMARK");
    expect(result.dataQuality.estimatedInputs).toContain("processingFees");
  });
});


describe("pricing product-cost completeness", () => {
  it("does not use incomplete business economics when another sold item has no resolved product cost", () => {
    const result = buildPricingViewModel({
      items: [item],
      business: { ...business, productCostsStatus: "missing" },
    })[0].result;
    expect(result.calculationMode).toBe("BENCHMARK");
    expect(result.businessAdjustmentFactor).toBe(1);
    expect(result.dataQuality.missingInputs).toContain("productCosts");
  });

  it("uses business economics when sold product costs are complete", () => {
    const result = buildPricingViewModel({
      items: [item],
      business: { ...business, productCostsStatus: "actual" },
    })[0].result;
    expect(result.calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result.dataQuality.missingInputs).not.toContain("productCosts");
  });
});


describe("pricing estimated owner product costs", () => {
  it("uses estimated product cost economics but marks the result estimated", () => {
    const result = buildPricingViewModel({
      items: [item],
      business: { ...business, productCostsStatus: "estimated" },
    })[0].result;
    expect(result.calculationMode).toBe("BUSINESS_ADJUSTED");
    expect(result.dataQuality.estimatedInputs).toContain("productCosts");
  });
});
