import { differenceInCalendarDays, getDaysInMonth, parseISO } from "date-fns";
import { sumCents } from "./money";
import type { CategoryMonthlyAmount, ExpenseForCategory, RecurringForCategory } from "./types";

/**
 * Monthly amount of a category = actual expenses recorded for that month if any exist,
 * otherwise the recurring estimate. Label as estimate if any part is estimated.
 */
export function monthlyAmountForCategory(
  expensesThisMonth: ExpenseForCategory[],
  recurring: RecurringForCategory | null,
): { amountCents: number; isEstimate: boolean; isMissing: boolean } {
  if (expensesThisMonth.length > 0) {
    return {
      amountCents: sumCents(expensesThisMonth, (e) => e.amountCents),
      isEstimate: expensesThisMonth.some((e) => e.status === "estimated"),
      isMissing: false,
    };
  }
  if (recurring) {
    return { amountCents: recurring.amountCents, isEstimate: recurring.isEstimate, isMissing: false };
  }
  return { amountCents: 0, isEstimate: false, isMissing: true };
}

// Local (not UTC) Date construction throughout this file: date-fns's calendar helpers
// (getDaysInMonth, differenceInCalendarDays) read local getters, and parseISO already
// parses a date-only string ("2026-09-01") as local midnight. Mixing in Date.UTC() would
// shift the calendar date by the system's UTC offset and silently miscount days-in-month.
function overlapDays(periodStart: string, periodEnd: string, monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0); // last day of month
  const start = maxDate(parseISO(periodStart), monthStart);
  const end = minDate(parseISO(periodEnd), monthEnd);
  const days = differenceInCalendarDays(end, start) + 1;
  return Math.max(0, days);
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() > b.getTime() ? a : b;
}
function minDate(a: Date, b: Date): Date {
  return a.getTime() < b.getTime() ? a : b;
}

function daysInMonthKey(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  return getDaysInMonth(new Date(year, month - 1, 1));
}

/**
 * Running costs for a period = Σ over running-cost categories: monthly amount ÷ days in that
 * month × days of the period that fall in that month. `categoryMonthlyAmounts` should have one
 * entry per (category, calendar month) the period touches.
 */
export function runningCostsForPeriodCents(
  categoryMonthlyAmounts: CategoryMonthlyAmount[],
  periodStart: string,
  periodEnd: string,
): number {
  return sumCents(categoryMonthlyAmounts, (c) => {
    const days = overlapDays(periodStart, periodEnd, c.monthKey);
    if (days === 0) return 0;
    return (c.amountCents / daysInMonthKey(c.monthKey)) * days;
  });
}

/** Running costs per day for the calendar month `monthKey`, undiluted by period overlap. */
export function runningCostsPerDayCents(categoryAmountsCents: number[], monthKey: string): number {
  return sumCents(categoryAmountsCents, (c) => c) / daysInMonthKey(monthKey);
}
