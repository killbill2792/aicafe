import { describe, expect, it } from "vitest";
import { scenarioDelayDays, scenarioExtraCostCents } from "./scenario";

describe("scenario", () => {
  it("computes extra cost across every drink sold over the scenario window", () => {
    // Oat milk latte: ingredients go from $0.95 to free ($0), 80 lattes/day, 5 days.
    expect(scenarioExtraCostCents(-95, 80, 5)).toBe(-38_000);
  });

  it("rounds to the nearest cent", () => {
    expect(scenarioExtraCostCents(33, 33, 3)).toBe(3_267); // 33 * 33 * 3 = 3267 exactly, sanity check
    expect(scenarioExtraCostCents(10.4, 3, 1)).toBe(31); // 31.2 -> 31
  });

  it("converts extra cost into a delay in days against the average daily contribution", () => {
    expect(scenarioDelayDays(38_000, 19_000)).toBe(2);
    expect(scenarioDelayDays(-38_000, 19_000)).toBe(-2); // a savings pulls recovery in, not back
  });

  it("a scenario with no cost impact never delays anything, even with zero contribution", () => {
    expect(scenarioDelayDays(0, 0)).toBe(0);
  });

  it("an unrecoverable extra cost against zero daily contribution is reported as never", () => {
    expect(scenarioDelayDays(1_000, 0)).toBe(Infinity);
  });
});
