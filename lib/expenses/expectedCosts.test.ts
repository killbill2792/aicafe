import { describe, expect, it } from "vitest";
import { expectedMissingCostLines, isExpectedCostCategory, missingCostDestination } from "./expectedCosts";

describe("expected running costs", () => {
  it("requires evidence before treating an unused category as missing", () => {
    expect(isExpectedCostCategory("repairs", { hasActiveRecurring: false, hadActualPreviousMonth: false })).toBe(false);
    expect(expectedMissingCostLines([{ categoryCode: "repairs", label: "Repairs", amountCents: 0, isEstimate: false, isMissing: true, isExpected: false }])).toEqual([]);
  });

  it("does not make sporadic costs permanent, but keeps deterministic monthly expectations", () => {
    expect(isExpectedCostCategory("repairs", { hasActiveRecurring: false, hadActualPreviousMonth: true })).toBe(false);
    expect(isExpectedCostCategory("other", { hasActiveRecurring: false, hadActualPreviousMonth: true })).toBe(false);
    expect(isExpectedCostCategory("rent", { hasActiveRecurring: true, hadActualPreviousMonth: false })).toBe(true);
    expect(isExpectedCostCategory("water", { hasActiveRecurring: false, hadActualPreviousMonth: true })).toBe(true);
  });

  it("routes recurring and variable categories to their real owner workflows", () => {
    expect(missingCostDestination("rent")).toBe("/more/bills?category=rent");
    expect(missingCostDestination("supplies")).toBe("/add-cost/type?category=supplies");
    expect(missingCostDestination("repairs")).toBe("/add-cost/type?category=repairs");
  });
});
