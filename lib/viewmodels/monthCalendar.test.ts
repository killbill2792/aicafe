import { describe, expect, it } from "vitest";
import { zeroDailyFacts } from "@/lib/calc";
import type { OpenHours } from "@/lib/business/openHours";
import type { MonthCalendarData } from "@/lib/data/monthCalendar.server";
import { buildMonthCalendarViewModel, isValidMonthKey, nextMonthKey, previousMonthKey } from "./monthCalendar";

const CATEGORY_AMOUNTS: MonthCalendarData["categoryAmounts"] = [
  { categoryCode: "rent", monthKey: "2026-10", amountCents: 31_000, isEstimate: false, isMissing: false },
];

function monthData(days: MonthCalendarData["days"], openHours: OpenHours | null = null): MonthCalendarData {
  return { monthKey: "2026-10", daysInMonth: 31, days, categoryAmounts: CATEGORY_AMOUNTS, openHours };
}

describe("buildMonthCalendarViewModel", () => {
  it("colors a profitable actual day green and an unprofitable one red, not by sales alone", () => {
    const goodDay = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 5_000 };
    const badDay = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 500 };
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([goodDay, badDay]),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-01")!.state).toEqual({ kind: "actual", ownerProfitCents: 4_000, tone: "good", isEstimate: false });
    expect(vm.cells.find((c) => c.date === "2026-10-02")!.state).toEqual({ kind: "actual", ownerProfitCents: -500, tone: "warn", isEstimate: false });
  });

  it("flags a day's profit when a running-cost input is estimated", () => {
    const day = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 5_000 };
    const vm = buildMonthCalendarViewModel({
      monthData: {
        ...monthData([day]),
        categoryAmounts: [
          { categoryCode: "rent", monthKey: "2026-10", amountCents: 20_000, isEstimate: false, isMissing: false },
          { categoryCode: "water", monthKey: "2026-10", amountCents: 1_000, isEstimate: true, isMissing: false },
        ],
      },
      recoveryOrder: ["rent", "water"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-01")!.state).toMatchObject({ kind: "actual", isEstimate: true });
    expect(vm.detailsByDate["2026-10-01"].runningCostShareIsEstimate).toBe(true);
  });

  it("does not flag a day when every contributing category is actual", () => {
    const day = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 5_000 };
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([day]),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-01")!.state).toMatchObject({ isEstimate: false });
    expect(vm.detailsByDate["2026-10-01"].runningCostShareIsEstimate).toBe(false);
  });

  it("keeps a no-rollup day missing when regular hours are unset", () => {
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([]),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-05")!.state).toEqual({ kind: "missing" });
    expect(vm.detailsByDate["2026-10-05"]).toMatchObject({ hasData: false, isClosed: false });
  });

  it("marks only an explicitly configured closed day as closed", () => {
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([], {
        sat: [],
        sun: [["08:00", "14:00"]],
      }),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-03")!.state).toEqual({ kind: "closed" });
    expect(vm.detailsByDate["2026-10-03"]).toMatchObject({ hasData: false, isClosed: true });
    expect(vm.cells.find((c) => c.date === "2026-10-04")!.state).toEqual({ kind: "missing" });
  });

  it("lets recorded facts win on a normally closed day", () => {
    const saturday = { ...zeroDailyFacts("2026-10-03"), netSalesCents: 3_000 };
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([saturday], { sat: [] }),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-03")!.state.kind).toBe("actual");
    expect(vm.detailsByDate["2026-10-03"]).toMatchObject({ hasData: true, isClosed: false });
  });

  it("shows future explicitly closed days as closed and future open days as projected", () => {
    const vm = buildMonthCalendarViewModel({
      monthData: monthData([], {
        sat: [],
        sun: [["08:00", "14:00"]],
      }),
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-02",
      isCurrentMonth: true,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-03")!.state).toEqual({ kind: "closed" });
    expect(vm.cells.find((c) => c.date === "2026-10-04")!.state).toEqual({ kind: "projected" });
  });

  it("marks future days of the current month projected when not explicitly closed", () => {
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

  it("attaches a bucket-covered milestone separately from day color", () => {
    const day1 = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 600 };
    const day2 = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 600 };
    const vm = buildMonthCalendarViewModel({
      monthData: {
        ...monthData([day1, day2]),
        categoryAmounts: [{ categoryCode: "rent", monthKey: "2026-10", amountCents: 1_000, isEstimate: false, isMissing: false }],
      },
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.cells.find((c) => c.date === "2026-10-01")!.milestoneBucketCodes).toEqual([]);
    expect(vm.cells.find((c) => c.date === "2026-10-02")!.milestoneBucketCodes).toEqual(["rent"]);
  });

  it("reports the actual date when all bills were covered", () => {
    const day = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 1_200 };
    const vm = buildMonthCalendarViewModel({
      monthData: { ...monthData([day]), categoryAmounts: [{ ...CATEGORY_AMOUNTS[0], amountCents: 1_000 }] },
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-31",
      isCurrentMonth: false,
    });
    expect(vm.coverageSignal).toEqual({ kind: "covered", date: "2026-10-02" });
  });

  it("reports a deterministic projected coverage date without changing day states", () => {
    const day = { ...zeroDailyFacts("2026-10-01"), netSalesCents: 400 };
    const vm = buildMonthCalendarViewModel({
      monthData: { ...monthData([day]), categoryAmounts: [{ ...CATEGORY_AMOUNTS[0], amountCents: 1_000 }] },
      recoveryOrder: ["rent"],
      todayDateStr: "2026-10-01",
      isCurrentMonth: true,
      projectedDays: [{ date: "2026-10-02", cents: 700, projected: true }],
    });
    expect(vm.coverageSignal).toEqual({ kind: "projected", date: "2026-10-02" });
    expect(vm.cells.find((cell) => cell.date === "2026-10-02")?.state).toEqual({ kind: "projected" });
  });
});

describe("month key navigation", () => {
  it("steps a month key forward and backward across a year boundary", () => {
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(previousMonthKey("2027-01")).toBe("2026-12");
  });
});

describe("isValidMonthKey", () => {
  it("accepts real YYYY-MM values", () => {
    expect(isValidMonthKey("2026-01")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
    expect(isValidMonthKey("2026-09")).toBe(true);
  });

  it("rejects malformed and out-of-range values", () => {
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-1")).toBe(false);
    expect(isValidMonthKey("2026-10-01")).toBe(false);
    expect(isValidMonthKey(undefined)).toBe(false);
    expect(isValidMonthKey(null)).toBe(false);
  });
});
