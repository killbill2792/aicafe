import { computeCostRecovery, roundHalfUpToCent, runningCostsForPeriodCents, type DayContribution, type RecoveryBucket } from "@/lib/calc";
import { regularHoursStateForDate } from "@/lib/business/openHours";
import type { MonthCalendarData } from "@/lib/data/monthCalendar.server";
import { dayContributionCents, recoveryBucketsFromAmounts } from "./costRecoveryShared";
import { previousMonthKey } from "./period";
import { profitTone, type ProfitTone } from "./profitTone";

export type DayCellState =
  | { kind: "actual"; ownerProfitCents: number; tone: ProfitTone; isEstimate: boolean }
  /** Explicitly closed according to the café's configured regular hours. */
  | { kind: "closed" }
  /** No rollup exists and the café was not explicitly configured closed. */
  | { kind: "missing" }
  /** A future open/unknown day of the current month. */
  | { kind: "projected" };

export type DayCell = {
  date: string;
  day: number;
  state: DayCellState;
  milestoneBucketCodes: string[];
};

export type DayDetail = {
  date: string;
  hasData: boolean;
  isClosed: boolean;
  salesCents: number;
  ingredientsCents: number;
  staffCents: number;
  cardFeesCents: number;
  runningCostShareCents: number;
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
  const { monthKey, daysInMonth, days, categoryAmounts, openHours } = monthData;

  const buckets: RecoveryBucket[] = recoveryBucketsFromAmounts(categoryAmounts, recoveryOrder);
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
    const dayFacts = days.find((d) => d.date === date);

    // Recorded facts always win over the regular-hours profile. This allows a special opening on
    // a normally closed day to show the real business activity rather than hiding it as "Closed."
    if (dayFacts) {
      const runningCostShareCents = roundHalfUpToCent(runningCostsForPeriodCents(categoryAmounts, date, date));
      const staffCents = dayFacts.wagesCents + dayFacts.staffTaxCents;
      const ownerProfitCents = dayFacts.netSalesCents - dayFacts.ingredientsCents - staffCents - dayFacts.cardFeesCents - runningCostShareCents;
      const tone = profitTone(ownerProfitCents);

      cells.push({ date, day, state: { kind: "actual", ownerProfitCents, tone, isEstimate: hasEstimatedCosts }, milestoneBucketCodes });
      detailsByDate[date] = {
        date,
        hasData: true,
        isClosed: false,
        salesCents: dayFacts.netSalesCents,
        ingredientsCents: dayFacts.ingredientsCents,
        staffCents,
        cardFeesCents: dayFacts.cardFeesCents,
        runningCostShareCents,
        runningCostShareIsEstimate: hasEstimatedCosts,
        ownerProfitCents,
        milestoneBucketCodes,
      };
      continue;
    }

    if (regularHoursStateForDate(openHours, date) === "closed") {
      cells.push({ date, day, state: { kind: "closed" }, milestoneBucketCodes: [] });
      detailsByDate[date] = {
        date,
        hasData: false,
        isClosed: true,
        salesCents: 0,
        ingredientsCents: 0,
        staffCents: 0,
        cardFeesCents: 0,
        runningCostShareCents: 0,
        runningCostShareIsEstimate: false,
        ownerProfitCents: 0,
        milestoneBucketCodes: [],
      };
      continue;
    }

    if (isCurrentMonth && date > todayDateStr) {
      cells.push({ date, day, state: { kind: "projected" }, milestoneBucketCodes: [] });
      continue;
    }

    cells.push({ date, day, state: { kind: "missing" }, milestoneBucketCodes: [] });
    detailsByDate[date] = {
      date,
      hasData: false,
      isClosed: false,
      salesCents: 0,
      ingredientsCents: 0,
      staffCents: 0,
      cardFeesCents: 0,
      runningCostShareCents: 0,
      runningCostShareIsEstimate: false,
      ownerProfitCents: 0,
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

export function isValidMonthKey(value: string | undefined | null): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
