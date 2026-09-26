import { runningCostsForPeriodCents, type CategoryMonthlyAmount, type DailyFacts } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";

export type Period = "today" | "week" | "month";

export function daysForPeriod(snapshot: BusinessSnapshot, period: Period): DailyFacts[] {
  if (period === "today") return [snapshot.latestDay];
  if (period === "week") return snapshot.last7Days;
  return snapshot.monthActualDays;
}

/** The same-length window ending at the same point, one period back — for "vs last period" arrows. */
export function previousPeriodDays(snapshot: BusinessSnapshot, period: Period): DailyFacts[] {
  if (period === "month") return snapshot.previousMonthDays.slice(0, snapshot.monthActualDays.length);
  if (period === "week") return snapshot.last28Days.slice(-14, -7);
  return snapshot.last28Days.slice(-2, -1); // yesterday
}

function previousMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const prev = new Date(year, month - 2, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * This month's running-cost lines, for both the current and previous calendar month — a "week"
 * or "today" comparison can dip a few days into the prior month. We don't have the prior month's
 * actual bills in the snapshot, so this approximates them as unchanged from this month; only
 * `runningCostLines`-driven proration for dates outside the current month uses this fallback.
 */
function categoryMonthlyAmounts(snapshot: BusinessSnapshot): CategoryMonthlyAmount[] {
  const forMonth = (monthKey: string) =>
    snapshot.runningCostLines.map((line) => ({
      categoryCode: line.categoryCode,
      monthKey,
      amountCents: line.amountCents,
      isEstimate: line.isEstimate,
      isMissing: line.isMissing,
    }));
  return [...forMonth(snapshot.monthKey), ...forMonth(previousMonthKey(snapshot.monthKey))];
}

/** Running costs prorated across the same date range as `days` (see docs/05-calculations.md). */
export function runningCostsForDays(snapshot: BusinessSnapshot, days: DailyFacts[]): number {
  if (days.length === 0) return 0;
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  return runningCostsForPeriodCents(categoryMonthlyAmounts(snapshot), sorted[0].date, sorted[sorted.length - 1].date);
}

export function periodLabel(period: Period): "Today" | "Week" | "Month" {
  return period === "today" ? "Today" : period === "week" ? "Week" : "Month";
}
