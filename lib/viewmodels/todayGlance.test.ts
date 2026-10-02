import { describe, expect, it } from "vitest";
import { buildTodayGlanceViewModel } from "./todayGlance";
import { zeroDailyFacts } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";

const BUCKETS: BusinessSnapshot["runningCostLines"] = [
  { categoryCode: "rent", label: "Rent", amountCents: 1_000, isEstimate: false, isMissing: false },
  { categoryCode: "utilities_power", label: "Electricity & gas", amountCents: 500, isEstimate: false, isMissing: false },
];

function buildSnapshot(opts: {
  todayHasData: boolean;
  today?: Partial<ReturnType<typeof zeroDailyFacts>>;
  monthActualDays?: BusinessSnapshot["monthActualDays"];
  runningCostLines?: BusinessSnapshot["runningCostLines"];
}): BusinessSnapshot {
  const todayDateStr = "2026-10-03";
  const today = { ...zeroDailyFacts(todayDateStr), ...opts.today };
  const runningCostLines = opts.runningCostLines ?? BUCKETS;
  return {
    business: { id: "test", name: "Test Café", timezone: "America/Los_Angeles", payrollTaxRate: 0 },
    todayDateStr,
    monthKey: "2026-10",
    daysInMonth: 31,
    monthActualDays: opts.monthActualDays ?? (opts.todayHasData ? [today] : []),
    last28Days: [],
    last7Days: [],
    todayDay: today,
    todayHasData: opts.todayHasData,
    previousMonthDays: [],
    runningCostLines,
    recoveryOrder: runningCostLines.map((l) => l.categoryCode),
    menuItems: [],
    alerts: { count: 0, leakingCents: 0 },
    staffShiftsToday: [],
    staffNowIso: `${todayDateStr}T09:00:00-07:00`,
  };
}

describe("buildTodayGlanceViewModel", () => {
  it("is 'noSalesYet' when today has no rollup at all — not a substituted stale day", () => {
    const snapshot = buildSnapshot({ todayHasData: false });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "noSalesYet" });
    expect(vm.salesCents).toBe(0);
  });

  it("is 'noBills' when there are no running-cost buckets to track progress against", () => {
    const snapshot = buildSnapshot({ todayHasData: true, today: { netSalesCents: 10_000 }, runningCostLines: [] });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "noBills" });
  });

  it("computes sales/orders/avg-order/money-left straight from today's row", () => {
    const snapshot = buildSnapshot({
      todayHasData: true,
      today: { netSalesCents: 10_000, ordersCount: 20, ingredientsCents: 2_000, cardFeesCents: 300, wagesCents: 1_000, staffTaxCents: 100 },
    });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.salesCents).toBe(10_000);
    expect(vm.ordersCount).toBe(20);
    expect(vm.avgOrderValueCents).toBe(500);
    expect(vm.moneyLeftCents).toBe(10_000 - 2_000 - 300 - 1_100); // net sales − ingredients − card fees − staff
  });

  it("is 'inProgress' with the correct bucket and post-today percentage when money stays in one bucket", () => {
    // Contribution today = 300 (all sales, no costs), landing entirely inside "rent" (1,000 total).
    const snapshot = buildSnapshot({ todayHasData: true, today: { netSalesCents: 300 } });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "inProgress", bucketCode: "rent", amountCents: 300, pctCoveredAfterToday: 30 });
  });

  it("is 'crossed' when today's money finishes one bucket and starts the next", () => {
    const yesterday = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 800 }; // rent at 800/1,000 before today
    const today = { ...zeroDailyFacts("2026-10-03"), netSalesCents: 700 }; // 800 -> 1,500: finishes rent, starts utilities
    const snapshot = buildSnapshot({ todayHasData: true, today, monthActualDays: [yesterday, today] });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "crossed", finishedBucketCode: "rent", startedBucketCode: "utilities_power" });
  });

  it("is 'allYours' once this month's cumulative already covers every bucket", () => {
    const yesterday = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 1_500 }; // already covers both buckets (1,500 total)
    const today = { ...zeroDailyFacts("2026-10-03"), netSalesCents: 400 };
    const snapshot = buildSnapshot({ todayHasData: true, today, monthActualDays: [yesterday, today] });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "allYours", amountCents: 400 });
  });

  it("is 'noProgressToday' when today has real data but nothing was left over for bills", () => {
    // Sales exist, but ingredients+staff+fees eat all of it — a real $0/negative contribution day,
    // not "nothing uploaded yet."
    const today = { ...zeroDailyFacts("2026-10-03"), netSalesCents: 1_000, ingredientsCents: 1_200 };
    const snapshot = buildSnapshot({ todayHasData: true, today });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "noProgressToday" });
  });

  it("is never 'allYours' when everything was covered before today but today lost money", () => {
    // Yesterday alone already covers both buckets (1,500 total); today's ingredients exceed sales.
    // Cost recovery can genuinely slip back below the final threshold on a bad day — "all yours"
    // must not be shown just because yesterday's cumulative cleared it.
    const yesterday = { ...zeroDailyFacts("2026-10-02"), netSalesCents: 2_000 };
    const today = { ...zeroDailyFacts("2026-10-03"), netSalesCents: 500, ingredientsCents: 900 };
    const snapshot = buildSnapshot({ todayHasData: true, today, monthActualDays: [yesterday, today] });
    const vm = buildTodayGlanceViewModel(snapshot);
    expect(vm.bucketState).toEqual({ kind: "noProgressToday" });
  });
});
