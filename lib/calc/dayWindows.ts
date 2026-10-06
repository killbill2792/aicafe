import { format, parseISO, subDays } from "date-fns";
import type { DailyFacts } from "./types";

/** A day with no `daily_rollups` row at all — every money/count field reads as a real $0/0,
 * never a stale carry-over from a different day. Callers that need to tell "genuinely zero" apart
 * from "no data yet" must check `DayWindows.todayHasData` alongside this, not infer it from the
 * numbers themselves. */
export function zeroDailyFacts(date: string): DailyFacts {
  return {
    date,
    netSalesCents: 0,
    ordersCount: 0,
    drinksCount: 0,
    ingredientsCents: 0,
    wagesCents: 0,
    staffTaxCents: 0,
    salesDataStatus: "missing",
    cardFeesCents: 0,
    voidsCents: 0,
  };
}

export type DayWindows = {
  /** Every rollup row this month, including staff-only rows whose sales coverage is missing. */
  monthRecordedDays: DailyFacts[];
  /** Sales-covered rows from `monthStart` (from `monthKey`) through `todayDateStr`, date-filtered — never
   * "whatever rows happen to be last in the array," so a gap before today can't smuggle in a wrong day. */
  monthActualDays: DailyFacts[];
  /** Actual rows whose date falls in the 7 calendar days ending `todayDateStr` — the real week window,
   * not simply "the last 7 rows," which silently breaks the moment any day in that window has no row
   * while an older row still exists in the table. */
  last7Days: DailyFacts[];
  /** Actual rows whose date falls in the 28 calendar days ending `todayDateStr` — same calendar-window
   * rule as `last7Days` (used for the "last four weeks" forecast/averages), not "the last 28 rows,"
   * which drifts from the real 28-day window the moment any day in it has no rollup. */
  last28Days: DailyFacts[];
  /** The row for `todayDateStr` itself, or a zero day for that exact date if none exists yet — never
   * a substitute for yesterday or whatever the most recently-inserted row happens to be. */
  todayDay: DailyFacts;
  /** False when `todayDay` is a fabricated zero (no real rollup for today yet) — callers use this to
   * show a coverage message instead of silently presenting the zero as a confirmed day. */
  todayHasData: boolean;
};

/** Actual rows whose date falls within the `n` calendar days ending `todayDateStr` (inclusive). */
export function hasSalesCoverage(day: DailyFacts): boolean {
  if (day.salesDataStatus === "actual") return true;
  // Positive sales facts are self-evidently covered even if an older fixture/import omitted the flag.
  if (day.netSalesCents !== 0 || day.ordersCount > 0 || day.drinksCount > 0) return true;
  // Undefined preserves legacy fixture/test semantics. Explicit "missing" with zero sales does not.
  return day.salesDataStatus !== "missing";
}

function lastNCalendarDays(allDays: DailyFacts[], todayDateStr: string, n: number): DailyFacts[] {
  const start = format(subDays(parseISO(todayDateStr), n - 1), "yyyy-MM-dd");
  return allDays.filter((d) => d.date >= start && d.date <= todayDateStr && hasSalesCoverage(d));
}

/**
 * Builds the four period windows (today / week / 28-day / month-to-date) directly from calendar
 * dates, independent of row order or gaps in `allDays` — see docs/03-screens.md and the Home/Money
 * period semantics fix: `allDays[allDays.length - 1]` (most recently inserted row) and
 * `allDays.slice(-7)` / `allDays.slice(-28)` ("last N rows") all silently drift from the real
 * calendar day/week/4-weeks the moment a day is missing a rollup, which is common for a café that
 * hasn't uploaded every day yet.
 */
export function buildDayWindows(allDays: DailyFacts[], todayDateStr: string, monthKey: string): DayWindows {
  const monthStart = `${monthKey}-01`;
  const monthRecordedDays = allDays.filter((d) => d.date >= monthStart && d.date <= todayDateStr);
  const monthActualDays = monthRecordedDays.filter(hasSalesCoverage);

  const last7Days = lastNCalendarDays(allDays, todayDateStr, 7);
  const last28Days = lastNCalendarDays(allDays, todayDateStr, 28);

  const todayRow = allDays.find((d) => d.date === todayDateStr);

  return {
    monthRecordedDays,
    monthActualDays,
    last7Days,
    last28Days,
    todayDay: todayRow ?? zeroDailyFacts(todayDateStr),
    todayHasData: Boolean(todayRow && hasSalesCoverage(todayRow)),
  };
}
