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

function proratedAmountCents(c: CategoryMonthlyAmount, periodStart: string, periodEnd: string): number {
  const days = overlapDays(periodStart, periodEnd, c.monthKey);
  if (days === 0) return 0;
  return (c.amountCents / daysInMonthKey(c.monthKey)) * days;
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
  return sumCents(categoryMonthlyAmounts, (c) => proratedAmountCents(c, periodStart, periodEnd));
}

/**
 * Same proration as `runningCostsForPeriodCents`, grouped per category instead of summed across
 * all of them — a category that spans two calendar months (e.g. "Week" dipping into last month)
 * gets its two entries' prorated amounts added together under one key. Powers the Money screen's
 * per-line running-cost rows so what's displayed for "Today"/"Week" actually reflects that period
 * instead of the full month's amount, while still reconciling to the same period total above.
 */
export function runningCostsForPeriodCentsByCategory(
  categoryMonthlyAmounts: CategoryMonthlyAmount[],
  periodStart: string,
  periodEnd: string,
): Map<string, number> {
  const byCategory = new Map<string, number>();
  for (const c of categoryMonthlyAmounts) {
    const prorated = proratedAmountCents(c, periodStart, periodEnd);
    byCategory.set(c.categoryCode, (byCategory.get(c.categoryCode) ?? 0) + prorated);
  }
  return byCategory;
}

/**
 * Rounds each category's raw (fractional) prorated amount to a whole cent via the "largest
 * remainder" method, so the per-category rows always sum to exactly `targetCents` — the rounded
 * AGGREGATE total (the same number `totalCostsCents` is built from), not just the sum of
 * independently-rounded rows. Rounding every category on its own (plain `Math.round` each) can
 * drift from the rounded aggregate by a cent or more once several categories don't divide evenly
 * (e.g. three $100/mo lines in a 31-day month: each raw share is 322.58...¢, independently
 * rounding each to 323¢ sums to 969¢, while the true aggregate 967.74...¢ rounds to 968¢).
 *
 * Deterministic: every category first gets `Math.floor(raw)`; the few cents still needed to reach
 * `targetCents` go to the categories with the largest fractional remainder first, ties broken by
 * category code ascending — so the same input always allocates the same way, independent of Map
 * iteration order.
 */
export function allocateIntegerCentsByCategory(rawAmountsByCategory: Map<string, number>, targetCents: number): Map<string, number> {
  const entries = [...rawAmountsByCategory.entries()].map(([categoryCode, raw]) => {
    const floor = Math.floor(raw);
    return { categoryCode, floor, remainder: raw - floor };
  });
  const base = entries.reduce((sum, e) => sum + e.floor, 0);
  const remaining = targetCents - base;
  const byRemainderDesc = [...entries].sort((a, b) => b.remainder - a.remainder || a.categoryCode.localeCompare(b.categoryCode));

  const result = new Map(entries.map((e) => [e.categoryCode, e.floor]));
  for (let i = 0; i < remaining && i < byRemainderDesc.length; i++) {
    const code = byRemainderDesc[i].categoryCode;
    result.set(code, (result.get(code) ?? 0) + 1);
  }
  return result;
}

/** Running costs per day for the calendar month `monthKey`, undiluted by period overlap. */
export function runningCostsPerDayCents(categoryAmountsCents: number[], monthKey: string): number {
  return sumCents(categoryAmountsCents, (c) => c) / daysInMonthKey(monthKey);
}
