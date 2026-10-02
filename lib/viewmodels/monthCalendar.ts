import { computeCostRecovery, roundHalfUpToCent, runningCostsForPeriodCents, type RecoveryBucket } from "@/lib/calc";
import type { MonthCalendarData } from "@/lib/data/monthCalendar.server";
import { dayContributionCents, recoveryBucketsFromAmounts } from "./costRecoveryShared";
import { previousMonthKey } from "./period";
import { profitTone, type ProfitTone } from "./profitTone";

export type DayCellState =
  | { kind: "actual"; ownerProfitCents: number; tone: ProfitTone }
  /** A real calendar day with no `daily_rollups` row at all — never colored or counted as $0. */
  | { kind: "missing" }
  /** A future day of the current month — shown dashed, no profit figure to report yet. */
  | { kind: "projected" };

export type DayCell = {
  date: string;
  day: number;
  state: DayCellState;
  /** Running-cost buckets that became fully paid back on exactly this date — a separate marker,
   * never what decides the cell's color (docs: "a separate marker/icon, not what determines the
   * entire day's color"). Always empty for "missing"/"projected" days. */
  milestoneBucketCodes: string[];
};

export type DayDetail = {
  date: string;
  hasData: boolean;
  salesCents: number;
  ingredientsCents: number;
  staffCents: number;
  cardFeesCents: number;
  runningCostShareCents: number;
  ownerProfitCents: number;
  milestoneBucketCodes: string[];
};

export type MonthCalendarViewModel = {
  monthKey: string;
  daysInMonth: number;
  cells: DayCell[];
  detailsByDate: Record<string, DayDetail>;
};

export function buildMonthCalendarViewModel(params: {
  monthData: MonthCalendarData;
  recoveryOrder: string[];
  todayDateStr: string;
  isCurrentMonth: boolean;
}): MonthCalendarViewModel {
  const { monthData, recoveryOrder, todayDateStr, isCurrentMonth } = params;
  const { monthKey, daysInMonth, days, categoryAmounts } = monthData;

  const buckets: RecoveryBucket[] = recoveryBucketsFromAmounts(categoryAmounts, recoveryOrder);
  const recovery = computeCostRecovery(
    buckets,
    days.map((d) => ({ date: d.date, cents: dayContributionCents(d), projected: false })),
  );
  const milestonesByDate = new Map<string, string[]>();
  for (const bucket of recovery.buckets) {
    if (!bucket.coveredOn) continue;
    milestonesByDate.set(bucket.coveredOn, [...(milestonesByDate.get(bucket.coveredOn) ?? []), bucket.code]);
  }

  const cells: DayCell[] = [];
  const detailsByDate: Record<string, DayDetail> = {};

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const milestoneBucketCodes = milestonesByDate.get(date) ?? [];

    if (isCurrentMonth && date > todayDateStr) {
      cells.push({ date, day, state: { kind: "projected" }, milestoneBucketCodes: [] });
      continue;
    }

    const dayFacts = days.find((d) => d.date === date);
    if (!dayFacts) {
      cells.push({ date, day, state: { kind: "missing" }, milestoneBucketCodes: [] });
      detailsByDate[date] = {
        date,
        hasData: false,
        salesCents: 0,
        ingredientsCents: 0,
        staffCents: 0,
        cardFeesCents: 0,
        runningCostShareCents: 0,
        ownerProfitCents: 0,
        milestoneBucketCodes,
      };
      continue;
    }

    const runningCostShareCents = roundHalfUpToCent(runningCostsForPeriodCents(categoryAmounts, date, date));
    const staffCents = dayFacts.wagesCents + dayFacts.staffTaxCents;
    const ownerProfitCents = dayFacts.netSalesCents - dayFacts.ingredientsCents - staffCents - dayFacts.cardFeesCents - runningCostShareCents;
    const tone = profitTone(ownerProfitCents);

    cells.push({ date, day, state: { kind: "actual", ownerProfitCents, tone }, milestoneBucketCodes });
    detailsByDate[date] = {
      date,
      hasData: true,
      salesCents: dayFacts.netSalesCents,
      ingredientsCents: dayFacts.ingredientsCents,
      staffCents,
      cardFeesCents: dayFacts.cardFeesCents,
      runningCostShareCents,
      ownerProfitCents,
      milestoneBucketCodes,
    };
  }

  return { monthKey, daysInMonth, cells, detailsByDate };
}

export function nextMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const next = new Date(year, month, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

export { previousMonthKey };

/** A real `YYYY-MM` with month 01–12 — e.g. rejects "2026-13", "2026-00", "2026-1", "2026-10-01".
 * Validated before `calMonth` (a URL search param, so arbitrary user/bot input) is ever used to
 * build a date range for a historical query. */
export function isValidMonthKey(value: string | undefined | null): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
