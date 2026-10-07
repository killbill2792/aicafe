import type { Timecard } from "./types";

/** docs/05-calculations.md "Alert rules (supporting)" — pure predicates over caller-supplied facts.
 * Wiring these to real queries, scheduling and UI copy is M7; these are just the math/logic. */

/** Missing bill: category has history (a recurring row, or an actual last month) but nothing this month. */
export function missingBillAlert(params: {
  hasRecurring: boolean;
  hadActualLastMonth: boolean;
  isMissingThisMonth: boolean;
}): boolean {
  return (params.hasRecurring || params.hadActualLastMonth) && params.isMissingThisMonth;
}

/** Voids: this month's voids > 2x the previous-3-months average, and > $100. */
export function voidsAlert(voidsThisMonthCents: number, avgVoidsPrevious3MonthsCents: number): boolean {
  return voidsThisMonthCents > 2 * avgVoidsPrevious3MonthsCents && voidsThisMonthCents > 10_000;
}

export type MealBreakStatus = {
  shiftHours: number;
  warn: boolean; // 4h30+ worked, no meal break taken yet
  missed: boolean; // 5h+ worked, no 30-min meal break started before the end of hour 5
  penaltyCents: number; // 1 hour of regular pay per day missed, California rule
};

/** Meal break (California): a 5h+ shift needs a 30-min break starting before the end of hour 5. */
export function mealBreakStatus(timecard: Timecard, now: Date = new Date()): MealBreakStatus {
  const clockInMs = new Date(timecard.clockIn).getTime();
  const clockOutMs = timecard.clockOut ? new Date(timecard.clockOut).getTime() : now.getTime();
  const shiftHours = Math.max(0, clockOutMs - clockInMs) / 3_600_000;

  // A materialized schedule can estimate wages, but it cannot prove that work happened or that a
  // planned break was taken/missed. Real compliance state only comes from confirmed timecards.
  if (timecard.sourceType === "owner_schedule" || (!timecard.sourceType && timecard.scheduleId)) {
    return { shiftHours, warn: false, missed: false, penaltyCents: 0 };
  }

  const tookQualifyingBreak = timecard.breaks.some((b) => {
    const breakStartHours = (new Date(b.start).getTime() - clockInMs) / 3_600_000;
    const breakMinutes = (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000;
    return breakStartHours <= 5 && breakMinutes >= 30;
  });

  const warn = shiftHours >= 4.5 && !tookQualifyingBreak;
  const missed = shiftHours > 5 && !tookQualifyingBreak;

  return { shiftHours, warn, missed, penaltyCents: missed ? timecard.hourlyWageCents : 0 };
}

/** Early clock-in: clocked in more than 7 minutes before the scheduled start. */
export function isEarlyClockIn(clockInIso: string, scheduledStartIso: string): boolean {
  const minutesEarly = (new Date(scheduledStartIso).getTime() - new Date(clockInIso).getTime()) / 60_000;
  return minutesEarly > 7;
}

/** Overstaffed slot: an hour-of-week where staff ÷ sales > 45% on at least 3 of the last 4 weeks. */
export function isOverstaffedSlot(lastFourWeeksRatios: number[]): boolean {
  return lastFourWeeksRatios.filter((r) => r > 0.45).length >= 3;
}

/** Covered milestone: positive = covered this many days faster than the same bucket last month. */
export function coveredMilestoneDaysFaster(dayOfMonthThisMonth: number, dayOfMonthLastMonth: number): number {
  return dayOfMonthLastMonth - dayOfMonthThisMonth;
}
