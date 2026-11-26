import "server-only";
import { readDailyFactRows } from "./dailyFacts.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CategoryMonthlyAmount, DailyFacts } from "@/lib/calc";
import { runningCostLinesForMonth, runningCostMonthlyAmount, rowToDailyFacts } from "./runningCostCatalog";
import {readCompletePaged} from "./completePages";
import { normalizeOpenHours, type OpenHours } from "@/lib/business/openHours";

export type MonthCalendarData = {
  monthKey: string;
  daysInMonth: number;
  /** Rollup rows this month only — staff-only rows may be present with salesDataStatus="missing". */
  days: DailyFacts[];
  /** One entry per running-cost category for this month, for proration via `runningCostsForPeriodCents`. */
  categoryAmounts: CategoryMonthlyAmount[];
  /** Current regular hours only. Historical months leave this unknown because hours aren't versioned. */
  openHours?: OpenHours | null;
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
  const [year,month]=monthKey.split("-").map(Number);
  const previous=new Date(year,month-2,1);
  const previousStart=String(previous.getFullYear()).padStart(4,"0")+"-"+String(previous.getMonth()+1).padStart(2,"0")+"-01";

  const [rollupResult, expensesResult, recurringResult, locationResult] = await Promise.all([
    readDailyFactRows(supabase, businessId, monthStart, monthEnd)
      .then((data) => ({ data, error: null }), (error: Error) => ({ data: null, error })),
    readCompletePaged((start,end)=>supabase.from("expenses")
      .select("id,category_code,amount_cents,status,spent_on,recurring_cost_id,custom_label,vendor,source",{count:"exact"})
      .eq("business_id",businessId).gte("spent_on",previousStart).lte("spent_on",monthEnd)
      .order("id",{ascending:true}).range(start,end),row=>row.id),
    readCompletePaged((start,end)=>supabase.from("recurring_costs")
      .select("id,category_code,amount_cents,frequency,is_estimate,active_from,active_to,label,due_day,source",{count:"exact"})
      .eq("business_id",businessId).lte("active_from",monthEnd)
      .or(`active_to.is.null,active_to.gte.${monthStart}`).order("id",{ascending:true}).range(start,end),row=>row.id),
    supabase
      .from("locations")
      .select("open_hours")
      .eq("business_id", businessId)
      .order("name", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (rollupResult.error) throw rollupResult.error;
  if(expensesResult===null||recurringResult===null)throw Error("calendar_cost_source_incomplete");
  if (locationResult.error) throw locationResult.error;

  const days = (rollupResult.data ?? []).map(rowToDailyFacts);

  const categoryAmounts:CategoryMonthlyAmount[]=runningCostLinesForMonth({
    expenses:expensesResult,recurring:recurringResult,from:monthStart,to:monthEnd,
    today:monthEnd,historical:!isCurrentMonth,priorExpenses:expensesResult
  }).map(line=>runningCostMonthlyAmount(line,monthKey));

  return { monthKey, daysInMonth, days, categoryAmounts, openHours: isCurrentMonth ? normalizeOpenHours(locationResult.data?.open_hours) : null };
}
