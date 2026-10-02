import { describe, expect, it } from "vitest";
import { expectedMissingCostLines, isExpectedCostCategory, missingCostDestination } from "./expectedCosts";

describe("expected running costs", () => {
  it("requires evidence before treating an unused category as missing", () => {
    expect(isExpectedCostCategory({ hasActiveRecurring: false, hasPriorActual: false })).toBe(false);
    expect(isExpectedCostCategory({ hasActiveRecurring: false, hasPriorActual: true })).toBe(true);
    expect(expectedMissingCostLines([{ categoryCode: "repairs", label: "Repairs", amountCents: 0, isEstimate: false, isMissing: true, isExpected: false }])).toEqual([]);
  });

  it("routes recurring and variable categories to their real owner workflows", () => {
    expect(missingCostDestination("rent")).toBe("/more/bills?category=rent");
    expect(missingCostDestination("supplies")).toBe("/add-cost/type?category=supplies");
    expect(missingCostDestination("repairs")).toBe("/add-cost/type?category=repairs");
  });
});
