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
    cardFeesCents: 0,
    voidsCents: 0,
  };
}

export type DayWindows = {
  /** Actual rows from `monthStart` (from `monthKey`) through `todayDateStr`, date-filtered — never
   * "whatever rows happen to be last in the array," so a gap before today can't smuggle in a wrong day. */
  monthActualDays: DailyFacts[];
  /** Actual rows whose date falls in the 7 calendar days ending `todayDateStr` — the real week window,
   * not simply "the last 7 rows," which silently breaks the moment any day in that window has no row
   * while an older row still exists in the table. */
  last7Days: DailyFacts[];
  /** The row for `todayDateStr` itself, or a zero day for that exact date if none exists yet — never
   * a substitute for yesterday or whatever the most recently-inserted row happens to be. */
  todayDay: DailyFacts;
  /** False when `todayDay` is a fabricated zero (no real rollup for today yet) — callers use this to
   * show a coverage message instead of silently presenting the zero as a confirmed day. */
  todayHasData: boolean;
};

/**
 * Builds the three period windows (today / week / month-to-date) directly from calendar dates,
 * independent of row order or gaps in `allDays` — see docs/03-screens.md and the Home/Money period
 * semantics fix: `allDays[allDays.length - 1]` (most recently inserted row) and `allDays.slice(-7)`
 * ("last 7 rows") both silently drift from the real calendar day/week the moment a day is missing a
 * rollup, which is common for a café that hasn't uploaded every day yet.
 */
export function buildDayWindows(allDays: DailyFacts[], todayDateStr: string, monthKey: string): DayWindows {
  const monthStart = `${monthKey}-01`;
  const monthActualDays = allDays.filter((d) => d.date >= monthStart && d.date <= todayDateStr);

  const weekStart = format(subDays(parseISO(todayDateStr), 6), "yyyy-MM-dd");
  const last7Days = allDays.filter((d) => d.date >= weekStart && d.date <= todayDateStr);

  const todayRow = allDays.find((d) => d.date === todayDateStr);

  return {
    monthActualDays,
    last7Days,
    todayDay: todayRow ?? zeroDailyFacts(todayDateStr),
    todayHasData: Boolean(todayRow),
  };
}
