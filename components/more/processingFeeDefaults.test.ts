import { describe, expect, it } from "vitest";
import {
  firstUncoveredSalesDay,
  initialCardSalesShareBps,
  missingCoverageSaveOptions,
} from "./processingFeeDefaults";

describe("processing fee redesign defaults", () => {
  const days = [
    { date: "2026-10-22", status: "missing" as const },
    { date: "2026-08-07", status: "estimated" as const },
    { date: "2026-07-27", status: "missing" as const },
    { date: "2026-09-03", status: "actual" as const },
  ];

  it("defaults to the earliest uncovered sales day, not today", () => {
    expect(firstUncoveredSalesDay(days, "2026-10-23")).toBe("2026-07-27");
  });

  it("defaults to today when every sales day has actual or estimated coverage", () => {
    expect(firstUncoveredSalesDay(days.filter((day) => day.status !== "missing"), "2026-10-23")).toBe("2026-10-23");
  });

  it("defaults card sales to 100% only for exactly one processor", () => {
    expect(initialCardSalesShareBps(null, 1)).toBe(10_000);
    expect(initialCardSalesShareBps(null, 0)).toBeNull();
    expect(initialCardSalesShareBps(null, 2)).toBeNull();
    expect(initialCardSalesShareBps(8_000, 1)).toBe(8_000);
  });

  it("one-tap fix uses the first missing date, not the edited effective date", () => {
    expect(missingCoverageSaveOptions(days, "2026-10-23")).toEqual({
      coverMissing: true,
      effectiveFrom: "2026-07-27",
    });
  });
});
