import { describe, expect, it } from "vitest";
import { ownerProfitDisplayState } from "./ownerProfitDisplay";

describe("ownerProfitDisplayState", () => {
  it("is 'unavailable' when zero actual days of sales data exist — never a confirmed figure", () => {
    const result = ownerProfitDisplayState(-74_678, { actualDays: 0, expectedDays: 1 });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("is 'unavailable' for Today specifically when nothing's been uploaded yet", () => {
    const result = ownerProfitDisplayState(-24_613, { actualDays: 0, expectedDays: 1 });
    expect(result.kind).toBe("unavailable");
  });

  it("is 'partial' when some but not all of the period's days are covered, still carrying the real figure", () => {
    const result = ownerProfitDisplayState(-418_783, { actualDays: 3, expectedDays: 7 });
    expect(result).toEqual({ kind: "partial", ownerProfitCents: -418_783, tone: "warn" });
  });

  it("is 'complete' once every calendar day in the period has a rollup", () => {
    const result = ownerProfitDisplayState(12_500, { actualDays: 7, expectedDays: 7 });
    expect(result).toEqual({ kind: "complete", ownerProfitCents: 12_500, tone: "good" });
  });

  it("Today with its one day covered is 'complete', not 'partial' — today has no partial state", () => {
    const result = ownerProfitDisplayState(0, { actualDays: 1, expectedDays: 1 });
    expect(result).toEqual({ kind: "complete", ownerProfitCents: 0, tone: "neutral" });
  });
});
