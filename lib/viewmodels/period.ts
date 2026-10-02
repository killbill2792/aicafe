import { runningCostsForPeriodCents, runningCostsForPeriodCentsByCategory, type CategoryMonthlyAmount, type DailyFacts } from "@/lib/calc";
import type { BusinessSnapshot, RunningCostLine } from "@/lib/data/types";

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

// Local (not UTC) Date construction, matching every other calendar-math helper in this codebase
// (see runningCosts.ts's decision note) — a date-only string parsed with Date.UTC or a bare `new
// Date(str)` can silently land on the wrong calendar day once the system's UTC offset is involved.
function addDaysLocal(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
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

/**
 * The calendar date range a period covers — deliberately independent of which days actually have
 * a `daily_rollups` row. Rent and bills accrue every calendar day whether or not that day's sales
 * were ever uploaded, so "Week" and "Month" must prorate over 7 / days-elapsed-this-month calendar
 * days even when only today has recorded data — not collapse to whatever handful of days happen to
 * have rows, which is what silently made every period read identical for an owner who hasn't
 * uploaded a daily sales file for each day yet (found live: Today/Week/Month all showed the exact
 * same number because only one `daily_rollups` row existed at all).
 */
export function periodCalendarRange(snapshot: BusinessSnapshot, period: Period): { start: string; end: string } {
  const end = snapshot.todayDateStr;
  if (period === "today") return { start: end, end };
  if (period === "week") return { start: addDaysLocal(end, -6), end };
  return { start: `${snapshot.monthKey}-01`, end };
}

/** The same-length calendar window one period back, for "vs last period" running-cost comparisons —
 * same calendar-range principle as `periodCalendarRange`, not dependent on rollup-row coverage. */
export function previousPeriodCalendarRange(snapshot: BusinessSnapshot, period: Period): { start: string; end: string } {
  if (period === "today") {
    const yesterday = addDaysLocal(snapshot.todayDateStr, -1);
    return { start: yesterday, end: yesterday };
  }
  if (period === "week") {
    return { start: addDaysLocal(snapshot.todayDateStr, -13), end: addDaysLocal(snapshot.todayDateStr, -7) };
  }
  const prevMonthKey = previousMonthKey(snapshot.monthKey);
  const dayOfMonth = Number(snapshot.todayDateStr.split("-")[2]);
  const end = Math.min(dayOfMonth, daysInMonth(prevMonthKey));
  return { start: `${prevMonthKey}-01`, end: `${prevMonthKey}-${String(end).padStart(2, "0")}` };
}

/** Running costs prorated across a period's full calendar range (see `periodCalendarRange`). */
export function runningCostsForPeriod(snapshot: BusinessSnapshot, period: Period): number {
  const { start, end } = periodCalendarRange(snapshot, period);
  return runningCostsForPeriodCents(categoryMonthlyAmounts(snapshot), start, end);
}

/** The same per-category lines as `snapshot.runningCostLines`, but each `amountCents` prorated to
 * the selected period instead of the full month — so a "Today" or "Week" view shows Rent at its
 * actual share of that period, not the full monthly amount, matching the already-prorated total
 * and owner-profit figures computed from `runningCostsForPeriod` above. `label`/`isEstimate`/
 * `isMissing` are carried over unchanged; only the amount is period-scoped. */
export function runningCostLinesForPeriod(snapshot: BusinessSnapshot, period: Period): RunningCostLine[] {
  const { start, end } = periodCalendarRange(snapshot, period);
  const byCategory = runningCostsForPeriodCentsByCategory(categoryMonthlyAmounts(snapshot), start, end);
  // Left unrounded here, matching totalCostsCents/ownerProfitCents (see lib/calc/money.ts's
  // "round only at the end" convention) — Money/formatCents rounds at display time, so the
  // visible rows reconcile to the visible total instead of drifting from independent rounding.
  return snapshot.runningCostLines.map((line) => ({
    ...line,
    amountCents: line.isMissing ? 0 : byCategory.get(line.categoryCode) ?? 0,
  }));
}

/** Running costs for the comparison period one back (see `previousPeriodCalendarRange`). */
export function previousRunningCostsForPeriod(snapshot: BusinessSnapshot, period: Period): number {
  const { start, end } = previousPeriodCalendarRange(snapshot, period);
  return runningCostsForPeriodCents(categoryMonthlyAmounts(snapshot), start, end);
}

export function periodLabel(period: Period): "Today" | "Week" | "Month" {
  return period === "today" ? "Today" : period === "week" ? "Week" : "Month";
}
