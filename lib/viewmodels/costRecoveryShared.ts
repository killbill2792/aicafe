import type { DailyFacts, DayContribution, RecoveryBucket } from "@/lib/calc";
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

export function actualDayContributions(snapshot: BusinessSnapshot): DayContribution[] {
  return snapshot.monthActualDays.map((d) => ({ date: d.date, cents: dayContributionCents(d), projected: false }));
}

/**
 * Projected remaining days of the month: average contribution of the same weekday over the
 * last 4 weeks (fallback: last 14 days average) — docs/05-calculations.md "Cost recovery".
 */
export function projectedDayContributions(snapshot: BusinessSnapshot): DayContribution[] {
  const { monthActualDays, daysInMonth, monthKey, last28Days } = snapshot;
  if (monthActualDays.length >= daysInMonth) return [];

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
  for (let day = monthActualDays.length + 1; day <= daysInMonth; day++) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(year, month - 1, day).getDay();
    const history = byWeekday.get(weekday);
    const avg = history && history.length > 0 ? history.reduce((s, v) => s + v, 0) / history.length : fallbackAvg;
    projected.push({ date, cents: avg, projected: true });
  }
  return projected;
}
