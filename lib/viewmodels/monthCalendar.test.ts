import { describe, expect, it } from "vitest";
import { zeroDailyFacts } from "@/lib/calc";
import type { MonthCalendarData } from "@/lib/data/monthCalendar.server";
import { buildMonthCalendarViewModel, isValidMonthKey, nextMonthKey, previousMonthKey } from "./monthCalendar";

const CATEGORY_AMOUNTS: MonthCalendarData["categoryAmounts"] = [
  { categoryCode: "rent", monthKey: "2026-10", amountCents: 31_000, isEstimate: false, isMissing: false }, // 31,000¢/mo -> 1,000¢/day over 31 days
];

function monthData(days: MonthCalendarData["days"]): MonthCalendarData {
  return { monthKey: "2026-10", daysInMonth: 31, days, categoryAmounts: CATEGORY_AMOUNTS };
}

describe("buildMonthCalendarViewModel", () => {
  it("colors a profitable actual day green and an unprofitable one red, not by sales alone", () => {
    const goodDay = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 5_000 }; // 5,000 − 1,000 rent share = +4,000
    const badDay = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 500 }; // 500 − 1,000 rent share = −500
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([goodDay, badDay]),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });

    const cell1 = vm.cells.find((c) => c.date === "2026-10-01")!;
    const cell2 = vm.cells.find((c) => c.date === "2026-10-02")!;
    expect(cell1.state).toEqual({ kind: "actual", ownerProfitCents: 4_000, tone: "good" });
    expect(cell2.state).toEqual({ kind: "actual", ownerProfitCents: -500, tone: "warn" });
  });

  it("marks a day with no rollup as 'missing', never as a confirmed $0 day", () => {
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([]),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    const cell = vm.cells.find((c) => c.date === "2026-10-05")!;
    expect(cell.state).toEqual({ kind: "missing" });
    expect(vm.detailsByDate["2026-10-05"].hasData).toBe(false);
  });

  it("marks future days of the current month as 'projected', with no profit figure", () => {
    const today = { ...zeroDailyFacts("2026-10-03"), netSalesCents: 5_000 };
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([today]),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-03",
      isCurrentMonth: true,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-03")!.state.kind).toBe("actual");
    expect(vm.cells.find((c) => c.date === "2026-10-04")!.state).toEqual({ kind: "projected" });
    expect(vm.detailsByDate["2026-10-04"]).toBeUndefined();
  });

  it("attaches a bucket-covered milestone to the day it happened — separate from, not driving, that day's color", () => {
    // Rent's monthly total is 1,000¢ (its *bucket* threshold, for the sequential fill below) which
    // also prorates to ~32¢/day over 31 days (its daily *share*, for each day's own color) — same
    // monthly figure, two different uses, exactly as the real screen does.
    const day1 = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 600 }; // cumulative 600 — rent not yet covered
    const day2 = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 600 }; // cumulative 1,200 — rent (1,000) now covered
    const vm = buildMonthCalendarViewModel({
      monthData: {
        monthKey: "2026-10",
        daysInMonth: 31,
        days: [day1, day2],
        categoryAmounts: [{ categoryCode: "rent", monthKey: "2026-10", amountCents: 1_000, isEstimate: false, isMissing: false }],
      },
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    const cell1 = vm.cells.find((c) => c.date === "2026-10-01")!;
    const cell2 = vm.cells.find((c) => c.date === "2026-10-02")!;
    expect(cell1.milestoneBucketCodes).toEqual([]);
    expect(cell2.milestoneBucketCodes).toEqual(["rent"]);
    // Both days are plainly profitable (600 sales vs. a ~32¢ rent share) — the milestone marker
    // on day 2 doesn't make it a differently-colored day than day 1.
    expect(cell1.state.kind).toBe("actual");
    expect(cell2.state.kind).toBe("actual");
    expect((cell1.state as { tone: string }).tone).toBe("good");
    expect((cell2.state as { tone: string }).tone).toBe("good");
  });
});

describe("month key navigation", () => {
  it("steps a month key forward and backward across a year boundary", () => {
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(previousMonthKey("2027-01")).toBe("2026-12");
  });
});

describe("isValidMonthKey", () => {
  it("accepts real YYYY-MM values, month 01-12", () => {
    expect(isValidMonthKey("2026-01")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
    expect(isValidMonthKey("2026-09")).toBe(true);
  });

  it("rejects an out-of-range month", () => {
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-00")).toBe(false);
  });

  it("rejects malformed shapes — missing zero-padding, extra day segment, wrong separators", () => {
    expect(isValidMonthKey("2026-1")).toBe(false);
    expect(isValidMonthKey("2026-10-01")).toBe(false);
    expect(isValidMonthKey("2026/10")).toBe(false);
    expect(isValidMonthKey("26-10")).toBe(false);
  });

  it("rejects non-string, empty, and injection-ish input without throwing", () => {
    expect(isValidMonthKey(undefined)).toBe(false);
    expect(isValidMonthKey(null)).toBe(false);
    expect(isValidMonthKey("")).toBe(false);
    expect(isValidMonthKey("2026-10' OR '1'='1")).toBe(false);
  });
});
