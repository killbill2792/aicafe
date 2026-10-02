import { describe, expect, it } from "vitest";
import { buildDayWindows, zeroDailyFacts } from "./dayWindows";
import type { DailyFacts } from "./types";

function day(date: string, netSalesCents: number): DailyFacts {
  return { ...zeroDailyFacts(date), netSalesCents };
}

describe("buildDayWindows", () => {
  it("first day of a month: today and month-to-date can legitimately be the same single day", () => {
    const allDays = [day("2026-09-30", 50_000), day("2026-10-01", 12_000)];
    const result = buildDayWindows(allDays, "2026-10-01", "2026-10");

    expect(result.todayDay).toEqual(day("2026-10-01", 12_000));
    expect(result.todayHasData).toBe(true);
    expect(result.monthActualDays).toEqual([day("2026-10-01", 12_000)]);
  });

  it("later in the month with multiple rollups: month-to-date sums every day and differs from today", () => {
    const allDays = [day("2026-10-01", 10_000), day("2026-10-02", 11_000), day("2026-10-03", 9_000)];
    const result = buildDayWindows(allDays, "2026-10-03", "2026-10");

    expect(result.todayDay.netSalesCents).toBe(9_000);
    expect(result.monthActualDays.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const monthToDateSales = result.monthActualDays.reduce((s, d) => s + d.netSalesCents, 0);
    expect(monthToDateSales).toBe(30_000);
    expect(monthToDateSales).not.toBe(result.todayDay.netSalesCents);
  });

  it("missing today's row: today must not silently substitute the most recent existing day", () => {
    // Only Oct 1 has a rollup; "today" is Oct 2, which hasn't been uploaded yet.
    const allDays = [day("2026-09-28", 40_000), day("2026-09-29", 35_000), day("2026-10-01", 20_000)];
    const result = buildDayWindows(allDays, "2026-10-02", "2026-10");

    expect(result.todayHasData).toBe(false);
    expect(result.todayDay).toEqual(zeroDailyFacts("2026-10-02"));
    // Oct 1 stays a real month-to-date day — it must not be mistaken for "today" either.
    expect(result.monthActualDays.map((d) => d.date)).toEqual(["2026-10-01"]);
  });

  it("gaps in the last 7 calendar days: week uses the real date range, not simply the last 7 rows", () => {
    // 10 rows exist in total, but only 3 of them actually fall in the 7 calendar days ending today
    // (2026-10-02 back to 2026-09-26). A naive "last 7 rows" slice would reach back into September
    // rows that are outside that window and miss that Sep 27/30 and Oct 1/2 have no data at all.
    const allDays = [
      day("2026-09-01", 1),
      day("2026-09-05", 2),
      day("2026-09-10", 3),
      day("2026-09-15", 4),
      day("2026-09-20", 5),
      day("2026-09-24", 6),
      day("2026-09-26", 100),
      day("2026-09-28", 200),
      day("2026-09-29", 300),
      day("2026-10-01", 400),
    ];
    const result = buildDayWindows(allDays, "2026-10-02", "2026-09");

    expect(result.last7Days.map((d) => d.date)).toEqual(["2026-09-26", "2026-09-28", "2026-09-29", "2026-10-01"]);
    expect(result.last7Days.map((d) => d.netSalesCents)).toEqual([100, 200, 300, 400]);
  });

  it("week with no gaps still sums to exactly 7 calendar days when every day has a row", () => {
    const allDays = Array.from({ length: 10 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, 1_000 * (i + 1)));
    const result = buildDayWindows(allDays, "2026-10-10", "2026-10");
    expect(result.last7Days.map((d) => d.date)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
  });
});
