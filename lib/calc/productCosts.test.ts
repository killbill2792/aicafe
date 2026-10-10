import { describe, expect, it } from "vitest";
import { summarizeResolvedSoldProductCosts } from "./productCosts";

describe("summarizeResolvedSoldProductCosts", () => {
  it("aggregates resolved sold-item costs and rounds only once", () => {
    expect(summarizeResolvedSoldProductCosts([
      { quantitySoldLast28Days: 3, ingredientsCentsToday: 1.25, costStatus: "READY", costQuality: "actual" },
      { quantitySoldLast28Days: 2, ingredientsCentsToday: 2.25, costStatus: "READY", costQuality: "actual" },
    ])).toEqual({
      totalCostCents: 8,
      missingProductCosts: false,
      usesEstimatedProductCosts: false,
    });
  });

  it("flags a sold item with no resolved cost instead of treating it as free", () => {
    expect(summarizeResolvedSoldProductCosts([
      { quantitySoldLast28Days: 4, ingredientsCentsToday: 0, costStatus: "NO_RECIPE" },
    ])).toEqual({
      totalCostCents: 0,
      missingProductCosts: true,
      usesEstimatedProductCosts: false,
    });
  });

  it("propagates estimated provenance only for sold items actually used", () => {
    expect(summarizeResolvedSoldProductCosts([
      { quantitySoldLast28Days: 5, ingredientsCentsToday: 150, costStatus: "READY", costQuality: "estimated" },
      { quantitySoldLast28Days: 0, ingredientsCentsToday: 999, costStatus: "READY", costQuality: "estimated" },
    ])).toEqual({
      totalCostCents: 750,
      missingProductCosts: false,
      usesEstimatedProductCosts: true,
    });
  });
});
