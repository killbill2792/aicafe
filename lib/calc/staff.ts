import type { Timecard } from "./types";
import { roundHalfUpToCent } from "./money";

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

/** Total hours a weekly schedule commits to, across every day it's on — used to convert a
 * monthly/yearly salary into an hourly-equivalent rate. */
export function weeklyScheduledHours(days: { startTime: string; endTime: string; unpaidBreakMinutes: number }[]): number {
  return days.reduce((sum, d) => {
    const [startH, startM] = d.startTime.split(":").map(Number);
    const [endH, endM] = d.endTime.split(":").map(Number);
    const minutes = Math.max(0, endH * 60 + endM - (startH * 60 + startM)) - d.unpaidBreakMinutes;
    return sum + Math.max(0, minutes) / 60;
  }, 0);
}

/** An hourly wage is already what it is. A monthly or yearly salary needs a weekly-hours figure
 * to convert — 52 weeks/year, month = 1/12 of a year. Returns 0 (not Infinity/NaN) when
 * `hoursPerWeek` is 0 for a salaried period, since there's no rate to derive without hours — the
 * caller is expected to guard against writing that 0 as a real wage. */
export function hourlyWageCentsFromSalary(amountCents: number, period: "hour" | "month" | "year", hoursPerWeek: number): number {
  if (period === "hour") return amountCents;
  if (hoursPerWeek <= 0) return 0;
  const hoursPerYear = hoursPerWeek * 52;
  const annualCents = period === "year" ? amountCents : amountCents * 12;
  return roundHalfUpToCent(annualCents / hoursPerYear);
}
