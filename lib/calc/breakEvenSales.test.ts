import { describe, expect, it } from "vitest";
import { calculateBreakEvenSales } from "./breakEvenSales";

describe("monthly break-even sales", () => {
  it("combines monthly bills + staff, then accounts for variable ingredient/card costs", () => {
    const result = calculateBreakEvenSales({
      monthlyBillsCents: 746_700,
      monthlyStaffCents: 100_000,
      observedSalesCents: 1_000_000,
      observedIngredientCents: 300_000,
      observedProcessingFeesCents: 30_000,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.fixedMonthlyCostsCents).toBe(846_700);
    expect(result.contributionRate).toBeCloseTo(0.67);
    expect(result.breakEvenSalesCents).toBe(Math.round(846_700 / 0.67));
    expect(result.ingredientCostsAtBreakEvenCents).toBe(Math.round(result.breakEvenSalesCents * 0.30));
    expect(result.processingFeesAtBreakEvenCents).toBe(Math.round(result.breakEvenSalesCents * 0.03));
    expect(
      result.monthlyBillsCents +
        result.monthlyStaffCents +
        result.ingredientCostsAtBreakEvenCents +
        result.processingFeesAtBreakEvenCents,
    ).toBeCloseTo(result.breakEvenSalesCents, -1);
  });

  it("does not invent break-even without sales evidence", () => {
    expect(
      calculateBreakEvenSales({
        monthlyBillsCents: 746_700,
        monthlyStaffCents: 100_000,
        observedSalesCents: 0,
        observedIngredientCents: 0,
        observedProcessingFeesCents: 0,
      }),
    ).toEqual({ kind: "unavailable", reason: "NO_SALES" });
  });
});
