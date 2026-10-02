import { computeCostRecovery, roundHalfUpToCent, runningCostsForPeriodCents, type DayContribution, type RecoveryBucket } from "@/lib/calc";
import type { MonthCalendarData } from "@/lib/data/monthCalendar.server";
import { dayContributionCents, recoveryBucketsFromAmounts } from "./costRecoveryShared";
import { previousMonthKey } from "./period";
import { profitTone, type ProfitTone } from "./profitTone";

export type DayCellState =
  /** `isEstimate` is true when any running-cost category that fed this day's profit (current
   * month's own estimate flag, or — for a past month — the forced estimate a recurring-cost
   * fallback always carries, see `monthCalendar.server.ts`) is an estimate rather than an actual
   * recorded bill. The owner must be able to tell a confirmed daily profit from one calculated
   * against a guessed bill amount. */
  | { kind: "actual"; ownerProfitCents: number; tone: ProfitTone; isEstimate: boolean }
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
  /** See `DayCellState["actual"].isEstimate` — only meaningful when `hasData` is true. */
  runningCostShareIsEstimate: boolean;
  ownerProfitCents: number;
  milestoneBucketCodes: string[];
};

export type MonthCalendarViewModel = {
  monthKey: string;
  daysInMonth: number;
  cells: DayCell[];
  detailsByDate: Record<string, DayDetail>;
  coverageSignal:
    | { kind: "covered"; date: string }
    | { kind: "projected"; date: string }
    | { kind: "not_covered" }
    | { kind: "insufficient" };
};

export function buildMonthCalendarViewModel(params: {
  monthData: MonthCalendarData;
  recoveryOrder: string[];
  todayDateStr: string;
  isCurrentMonth: boolean;
  projectedDays?: DayContribution[];
}): MonthCalendarViewModel {
  const { monthData, recoveryOrder, todayDateStr, isCurrentMonth, projectedDays = [] } = params;
  const { monthKey, daysInMonth, days, categoryAmounts } = monthData;

  const buckets: RecoveryBucket[] = recoveryBucketsFromAmounts(categoryAmounts, recoveryOrder);
  // One flag for the whole month: `categoryAmounts` doesn't vary day to day within a single
  // month, so whether any category feeding the daily running-cost share is an estimate is the
  // same for every actual day in this view.
  const hasEstimatedCosts = categoryAmounts.some((c) => c.isEstimate && c.amountCents > 0);
  const recovery = computeCostRecovery(
    buckets,
    [...days.map((d) => ({ date: d.date, cents: dayContributionCents(d), projected: false })), ...(isCurrentMonth ? projectedDays : [])],
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
        runningCostShareIsEstimate: false,
        ownerProfitCents: 0,
        milestoneBucketCodes,
      };
      continue;
    }

    const runningCostShareCents = roundHalfUpToCent(runningCostsForPeriodCents(categoryAmounts, date, date));
    const staffCents = dayFacts.wagesCents + dayFacts.staffTaxCents;
    const ownerProfitCents = dayFacts.netSalesCents - dayFacts.ingredientsCents - staffCents - dayFacts.cardFeesCents - runningCostShareCents;
    const tone = profitTone(ownerProfitCents);

    cells.push({ date, day, state: { kind: "actual", ownerProfitCents, tone, isEstimate: hasEstimatedCosts }, milestoneBucketCodes });
    detailsByDate[date] = {
      date,
      hasData: true,
      salesCents: dayFacts.netSalesCents,
      ingredientsCents: dayFacts.ingredientsCents,
      staffCents,
      cardFeesCents: dayFacts.cardFeesCents,
      runningCostShareCents,
      runningCostShareIsEstimate: hasEstimatedCosts,
      ownerProfitCents,
      milestoneBucketCodes,
    };
  }

  const finalBucket = recovery.buckets.at(-1);
  const coverageSignal =
    !finalBucket || days.length === 0
      ? { kind: "insufficient" as const }
      : finalBucket.coveredOn
        ? { kind: "covered" as const, date: finalBucket.coveredOn }
        : isCurrentMonth && finalBucket.projectedCoveredOn
          ? { kind: "projected" as const, date: finalBucket.projectedCoveredOn }
          : { kind: "not_covered" as const };

  return { monthKey, daysInMonth, cells, detailsByDate, coverageSignal };
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
