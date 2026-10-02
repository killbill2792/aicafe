import type { CategoryMonthlyAmount, DailyFacts, DayContribution, RecoveryBucket } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";

/** Per_cup mode day contribution: net sales − ingredients − card fees − loaded staff cost. */
export function dayContributionCents(day: DailyFacts): number {
  return day.netSalesCents - day.ingredientsCents - day.cardFeesCents - (day.wagesCents + day.staffTaxCents);
}

export function recoveryBuckets(snapshot: BusinessSnapshot): RecoveryBucket[] {
  return snapshot.recoveryOrder
    .map((code) => snapshot.runningCostLines.find((l) => l.categoryCode === code))
    .filter((line): line is BusinessSnapshot["runningCostLines"][number] => Boolean(line) && line!.amountCents > 0)
    .map((line) => ({ code: line.categoryCode, amountCents: line.amountCents, isEstimate: line.isEstimate }));
}

/** Same bucket-building rule as `recoveryBuckets`, but from an arbitrary month's `categoryAmounts`
 * (see `getMonthCalendar`) instead of the live snapshot — so a past month's calendar sequences its
 * own bills, not whichever bills happen to be active today. */
export function recoveryBucketsFromAmounts(categoryAmounts: CategoryMonthlyAmount[], recoveryOrder: string[]): RecoveryBucket[] {
  return recoveryOrder
    .map((code) => categoryAmounts.find((c) => c.categoryCode === code))
    .filter((c): c is CategoryMonthlyAmount => Boolean(c) && c!.amountCents > 0)
    .map((c) => ({ code: c.categoryCode, amountCents: c.amountCents, isEstimate: c.isEstimate }));
}

export function actualDayContributions(snapshot: BusinessSnapshot): DayContribution[] {
  return snapshot.monthActualDays.map((d) => ({ date: d.date, cents: dayContributionCents(d), projected: false }));
}

/**
 * Projected remaining days of the month: average contribution of the same weekday over the
 * last 4 weeks (fallback: last 14 days average) — docs/05-calculations.md "Cost recovery".
 */
export function projectedDayContributions(snapshot: BusinessSnapshot): DayContribution[] {
  const { daysInMonth, monthKey, last28Days, todayDateStr } = snapshot;
  // Anchored to the real day-of-month of `todayDateStr`, not `monthActualDays.length` — a gap
  // before today (a day with no rollup yet) would otherwise shift every later date `length` was
  // standing in for, projecting the wrong calendar days as "the rest of the month."
  const todayDayOfMonth = Number(todayDateStr.slice(-2));
  if (todayDayOfMonth >= daysInMonth) return [];

  const [year, month] = monthKey.split("-").map(Number);
  const fallbackAvg =
    last28Days.length > 0 ? last28Days.slice(-14).reduce((s, d) => s + dayContributionCents(d), 0) / Math.min(14, last28Days.length) : 0;

  const byWeekday = new Map<number, number[]>();
  for (const d of last28Days) {
    const [y, m, day] = d.date.split("-").map(Number);
    const weekday = new Date(y, m - 1, day).getDay();
    const arr = byWeekday.get(weekday) ?? [];
    arr.push(dayContributionCents(d));
    byWeekday.set(weekday, arr);
  }

  const projected: DayContribution[] = [];
  for (let day = todayDayOfMonth + 1; day <= daysInMonth; day++) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(year, month - 1, day).getDay();
    const history = byWeekday.get(weekday);
    const avg = history && history.length > 0 ? history.reduce((s, v) => s + v, 0) / history.length : fallbackAvg;
    projected.push({ date, cents: avg, projected: true });
  }
  return projected;
}
