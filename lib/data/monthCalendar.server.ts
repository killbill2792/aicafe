import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryMonthlyAmount, DailyFacts, ExpenseCategoryCode } from "@/lib/calc";
import { RUNNING_COST_CODES, RUNNING_COST_LABELS, rowToDailyFacts } from "./runningCostCatalog";

export type MonthCalendarData = {
  monthKey: string;
  daysInMonth: number;
  /** Actual rollup rows this month only — never padded with fabricated zero days; a date with no
   * entry here has no sales data at all (see docs/03-screens.md "Money calendar"). */
  days: DailyFacts[];
  /** One entry per running-cost category for this month, for proration via `runningCostsForPeriodCents`. */
  categoryAmounts: CategoryMonthlyAmount[];
};

function daysInMonthKey(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

/**
 * The real month-specific read model for the Money calendar's "previous months" navigation
 * (docs/03-screens.md): unlike the live snapshot, this never uses *today's* current recurring-cost
 * amount to stand in for a past month's bills. Editing a bill in this app updates its
 * `recurring_costs` row in place rather than versioning it (see `saveRecurringCost`), so there is no
 * way to recover what a bill's amount truly was in a past month if it's since been edited — only
 * whether a recurring row was *active* (by `active_from`/`active_to`) during that month. Any
 * category that falls back to a recurring row for a strictly-past month is therefore always marked
 * `isEstimate: true`, never silently presented as a confirmed historical figure.
 */
export async function getMonthCalendarFromDb(
  supabase: SupabaseClient,
  businessId: string,
  monthKey: string,
  isCurrentMonth: boolean,
): Promise<MonthCalendarData> {
  const daysInMonth = daysInMonthKey(monthKey);
  const monthStart = `${monthKey}-01`;
  const monthEnd = `${monthKey}-${String(daysInMonth).padStart(2, "0")}`;

  const [rollupResult, expensesResult, recurringResult] = await Promise.all([
    supabase
      .from("daily_rollups")
      .select(
        "business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, card_fees_cents, voids_cents",
      )
      .eq("business_id", businessId)
      .gte("business_date", monthStart)
      .lte("business_date", monthEnd)
      .order("business_date", { ascending: true }),
    supabase
      .from("expenses")
      .select("category_code, amount_cents, status")
      .eq("business_id", businessId)
      .gte("spent_on", monthStart)
      .lte("spent_on", monthEnd),
    supabase
      .from("recurring_costs")
      .select("category_code, amount_cents, is_estimate, active_from, active_to")
      .eq("business_id", businessId)
      .lte("active_from", monthEnd)
      .or(`active_to.is.null,active_to.gte.${monthStart}`),
  ]);
  if (rollupResult.error) throw rollupResult.error;
  if (expensesResult.error) throw expensesResult.error;
  if (recurringResult.error) throw recurringResult.error;

  const days = (rollupResult.data ?? []).map(rowToDailyFacts);

  const categoryAmounts: CategoryMonthlyAmount[] = RUNNING_COST_CODES.map((code: ExpenseCategoryCode) => {
    const expensesThisMonth = (expensesResult.data ?? []).filter((e) => e.category_code === code);
    if (expensesThisMonth.length > 0) {
      return {
        categoryCode: code,
        monthKey,
        amountCents: expensesThisMonth.reduce((sum, e) => sum + e.amount_cents, 0),
        isEstimate: expensesThisMonth.some((e) => e.status === "estimated"),
        isMissing: false,
      };
    }

    const activeRecurring = (recurringResult.data ?? []).filter((r) => r.category_code === code);
    if (activeRecurring.length > 0) {
      return {
        categoryCode: code,
        monthKey,
        amountCents: activeRecurring.reduce((sum, r) => sum + r.amount_cents, 0),
        // A past month's recurring fallback can't be confirmed accurate for that month specifically
        // (see this function's doc comment) — only the live current month trusts the row's own flag.
        isEstimate: isCurrentMonth ? activeRecurring.some((r) => r.is_estimate) : true,
        isMissing: false,
      };
    }

    return { categoryCode: code, monthKey, amountCents: 0, isEstimate: false, isMissing: true };
  });

  return { monthKey, daysInMonth, days, categoryAmounts };
}

export function runningCostLabelFor(code: string): string {
  return RUNNING_COST_LABELS[code] ?? code;
}
