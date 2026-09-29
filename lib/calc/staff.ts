import type { Timecard } from "./types";

/** Paid hours worked = clocked time minus unpaid breaks; open shifts count up to `now`, and a
 * `clockOut` that hasn't happened yet (a schedule-predicted shift still in progress) is capped at
 * `now` too — a shift can never be paid for hours that haven't occurred, even when its end time
 * is already known in advance. */
export function paidHoursForTimecard(timecard: Timecard, now: Date = new Date()): number {
  const clockIn = new Date(timecard.clockIn).getTime();
  const clockOut = timecard.clockOut ? Math.min(new Date(timecard.clockOut).getTime(), now.getTime()) : now.getTime();
  const totalMs = Math.max(0, clockOut - clockIn);

  const unpaidBreakMs = timecard.breaks
    .filter((b) => !b.paid)
    .reduce((sum, b) => sum + Math.max(0, new Date(b.end).getTime() - new Date(b.start).getTime()), 0);

  return Math.max(0, totalMs - unpaidBreakMs) / 3_600_000;
}

export function wagesCentsForTimecard(timecard: Timecard, now: Date = new Date()): number {
  return paidHoursForTimecard(timecard, now) * timecard.hourlyWageCents;
}

export function wagesCentsForTimecards(timecards: Timecard[], now: Date = new Date()): number {
  return timecards.reduce((sum, tc) => sum + wagesCentsForTimecard(tc, now), 0);
}

/** Payroll taxes = wages × business.payroll_tax_rate (default 0.12). */
export function payrollTaxCents(wagesCents: number, payrollTaxRate: number): number {
  return wagesCents * payrollTaxRate;
}

/** Staff cost (loaded) = wages + payroll taxes. */
export function staffCostLoadedCents(wagesCents: number, staffTaxCents: number): number {
  return wagesCents + staffTaxCents;
}
