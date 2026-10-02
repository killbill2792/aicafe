import { describe, expect, it } from "vitest";
import { periodComparisonState } from "./periodComparison";

describe("periodComparisonState", () => {
  it("current complete Today + missing yesterday -> no comparison", () => {
    const result = periodComparisonState({ actualDays: 1, expectedDays: 1 }, { actualDays: 0, expectedDays: 1 });
    expect(result).toEqual({ kind: "notEnoughData" });
  });

  it("current partial week -> no misleading week-over-week comparison, even if the previous week is complete", () => {
    const result = periodComparisonState({ actualDays: 4, expectedDays: 7 }, { actualDays: 7, expectedDays: 7 });
    expect(result).toEqual({ kind: "notEnoughData" });
  });

  it("complete current + complete previous -> comparison still works", () => {
    const result = periodComparisonState({ actualDays: 7, expectedDays: 7 }, { actualDays: 7, expectedDays: 7 });
    expect(result).toEqual({ kind: "available" });
  });

  it("sparse previous month-to-date -> no misleading MTD comparison, even if the current month-to-date is complete", () => {
    const result = periodComparisonState({ actualDays: 5, expectedDays: 5 }, { actualDays: 2, expectedDays: 5 });
    expect(result).toEqual({ kind: "notEnoughData" });
  });

  it("zero actual days on either side is never 'available'", () => {
    expect(periodComparisonState({ actualDays: 0, expectedDays: 1 }, { actualDays: 1, expectedDays: 1 })).toEqual({ kind: "notEnoughData" });
    expect(periodComparisonState({ actualDays: 1, expectedDays: 1 }, { actualDays: 0, expectedDays: 1 })).toEqual({ kind: "notEnoughData" });
  });
});
