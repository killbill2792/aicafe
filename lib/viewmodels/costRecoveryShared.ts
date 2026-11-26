import { laborKnown } from "@/lib/calc";
import type { CategoryMonthlyAmount, DailyFacts, DayContribution, RecoveryBucket } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { regularHoursStateForDate } from "@/lib/business/openHours";

/** Per_cup mode day contribution: net sales − ingredients − card fees − loaded staff cost. */
export function dayContributionCents(day: DailyFacts): number | null {
  // Persisted days carry the canonical SQL value (including an explicit unknown).
  if(day.recordedContributionCents!==undefined)return day.recordedContributionCents;
  // Pure scenario/demo inputs have no database row; retain their local arithmetic.
  return !laborKnown(day)?null:
    day.netSalesCents-day.ingredientsCents-day.cardFeesCents-(day.wagesCents+day.staffTaxCents);
}

export function recoveryBuckets(snapshot: BusinessSnapshot): RecoveryBucket[] {
  // The configured recovery order sequences the evidence, never filters out
  // valid costs. Use the same rule as the historical calendar.
  return recoveryBucketsFromAmounts(snapshot.runningCostLines.map(line=>({
    categoryCode:line.categoryCode,monthKey:snapshot.monthKey,amountCents:line.amountCents,
    isEstimate:line.isEstimate,isMissing:line.isMissing,
  })),snapshot.recoveryOrder);
}

/** Same bucket-building rule as `recoveryBuckets`, but from an arbitrary month's `categoryAmounts`
 * (see `getMonthCalendar`) instead of the live snapshot — so a past month's calendar sequences its
 * own bills, not whichever bills happen to be active today. */
export function recoveryBucketsFromAmounts(categoryAmounts: CategoryMonthlyAmount[], recoveryOrder: string[]): RecoveryBucket[] {
  return [...new Set([...recoveryOrder,...categoryAmounts.map(c=>c.categoryCode)])]
    .map((code) => categoryAmounts.find((c) => c.categoryCode === code))
    .filter((c): c is CategoryMonthlyAmount => Boolean(c) && c!.amountCents > 0)
    .map((c) => ({ code: c.categoryCode, amountCents: c.amountCents, isEstimate: c.isEstimate }));
}

export function actualDayContributions(snapshot: BusinessSnapshot): DayContribution[] {
  return snapshot.monthActualDays.filter(d=>dayContributionCents(d)!==null)
    .map(d=>({date:d.date,cents:dayContributionCents(d)!,projected:false}));
}

/**
 * Projected remaining days of the month: average contribution of the same weekday over the
 * last 4 weeks (fallback: last 14 days average) — docs/05-calculations.md "Cost recovery".
 */
export function projectedDayContributions(snapshot: BusinessSnapshot): DayContribution[] {
  const {daysInMonth,monthKey,todayDateStr}=snapshot;
  const last28Days=snapshot.last28Days.filter(d=>dayContributionCents(d)!==null);
  // Anchored to the real day-of-month of `todayDateStr`, not `monthActualDays.length` — a gap
  // before today (a day with no rollup yet) would otherwise shift every later date `length` was
  // standing in for, projecting the wrong calendar days as "the rest of the month."
  const todayDayOfMonth = Number(todayDateStr.slice(-2));
  if (todayDayOfMonth >= daysInMonth) return [];

  const [year, month] = monthKey.split("-").map(Number);
  const fallbackAvg =
    last28Days.length > 0 ? last28Days.slice(-14).reduce((s, d) => s + dayContributionCents(d)!, 0) / Math.min(14, last28Days.length) : 0;

  const byWeekday = new Map<number, number[]>();
  for (const d of last28Days) {
    const [y, m, day] = d.date.split("-").map(Number);
    const weekday = new Date(y, m - 1, day).getDay();
    const arr = byWeekday.get(weekday) ?? [];
    arr.push(dayContributionCents(d)!);
    byWeekday.set(weekday, arr);
  }

  const projected: DayContribution[] = [];
  for (let day = todayDayOfMonth + 1; day <= daysInMonth; day++) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    if (regularHoursStateForDate(snapshot.business.openHours, date) === "closed") continue;
    const weekday = new Date(year, month - 1, day).getDay();
    const history = byWeekday.get(weekday);
    const avg = history && history.length > 0 ? history.reduce((s, v) => s + v, 0) / history.length : fallbackAvg;
    projected.push({ date, cents: avg, projected: true });
  }
  return projected;
}
