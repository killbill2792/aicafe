import {
  allocateIntegerCentsByCategory,
  roundHalfUpToCent,
  runningCostsForPeriodCents,
  runningCostsForPeriodCentsByCategory,
  type CategoryMonthlyAmount,
  type DailyFacts,
} from "@/lib/calc";
import type { BusinessSnapshot, RunningCostLine } from "@/lib/data/types";

export type Period = "today" | "week" | "month";

export function daysForPeriod(snapshot: BusinessSnapshot, period: Period): DailyFacts[] {
  if (period === "today") return [snapshot.todayDay];
  if (period === "week") return snapshot.last7Days;
  return snapshot.monthActualDays;
}

/** How much of a period's calendar range actually has a sales rollup — "today" is 0/1 when
 * nothing's been uploaded yet, "week"/"month" count real rows against the calendar days elapsed.
 * Lets the UI say "Sales data available for 1 of 2 days this month" instead of presenting a
 * period with sparse data as if it were simply a quiet one. */
export function periodCoverage(snapshot: BusinessSnapshot, period: Period): { actualDays: number; expectedDays: number } {
  if (period === "today") return { actualDays: snapshot.todayHasData ? 1 : 0, expectedDays: 1 };
  if (period === "week") return { actualDays: snapshot.last7Days.length, expectedDays: 7 };
  const dayOfMonth = Number(snapshot.todayDateStr.slice(-2));
  return { actualDays: snapshot.monthActualDays.length, expectedDays: dayOfMonth };
}

export function previousMonthKey(monthKey: string): string {
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

/** The actual rows that fall inside `previousPeriodCalendarRange` — date-filtered, never an array
 * slice. A previous-period window (today: yesterday only; week: the 7 calendar dates immediately
 * before the current 7-day window; month: previous month's day 1 through the equivalent
 * day-of-month) never reaches back further than the immediately preceding calendar month, so
 * `previousMonthDays` (that whole month's actual rows) plus `monthActualDays` (this month's,
 * so far) together cover every case — unlike `last28Days.slice(-2, -1)` /
 * `last28Days.slice(-14, -7)`, which pick "the Nth most recent row" and silently return the wrong
 * calendar day the moment any day in between has no rollup (found live: with rows Sep 28/29/Oct 1
 * and today Oct 2, "yesterday" by array position was Sep 29, not Oct 1). */
export function previousPeriodDays(snapshot: BusinessSnapshot, period: Period): DailyFacts[] {
  const { start, end } = previousPeriodCalendarRange(snapshot, period);
  const pool = [...snapshot.previousMonthDays, ...snapshot.monthActualDays];
  return pool.filter((d) => d.date >= start && d.date <= end);
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
 * `isMissing` are carried over unchanged; only the amount is period-scoped.
 *
 * Money is integer cents everywhere (CLAUDE.md rule 1), and the displayed rows must sum to
 * exactly the same rounded total the rest of the screen shows — rounding each category
 * independently can drift from the rounded aggregate by a cent or more (see
 * `allocateIntegerCentsByCategory`'s own doc comment for a worked example), so the target is the
 * rounded output of `runningCostsForPeriod` itself — the exact aggregate `totalCostsCents` is
 * built from — and cents are allocated deterministically to reach it exactly. */
export function runningCostLinesForPeriod(snapshot: BusinessSnapshot, period: Period): RunningCostLine[] {
  const { start, end } = periodCalendarRange(snapshot, period);
  const byCategory = runningCostsForPeriodCentsByCategory(categoryMonthlyAmounts(snapshot), start, end);
  const targetCents = roundHalfUpToCent(runningCostsForPeriod(snapshot, period));
  // Missing categories have no raw amount to round and must display as $0 — excluded from
  // allocation entirely, not just zeroed out afterward, so they never receive a stray cent.
  const rawByCategory = new Map(
    snapshot.runningCostLines.filter((line) => !line.isMissing).map((line) => [line.categoryCode, byCategory.get(line.categoryCode) ?? 0]),
  );
  const allocatedByCategory = allocateIntegerCentsByCategory(rawByCategory, targetCents);
  return snapshot.runningCostLines.map((line) => ({
    ...line,
    amountCents: line.isMissing ? 0 : allocatedByCategory.get(line.categoryCode) ?? 0,
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
