import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mealBreakStatus, missingBillAlert } from "@/lib/calc";
import { DEMO_BUSINESS_ID, RUNNING_COST_CODES } from "@/lib/constants";
import { blocksGeneratedAlert, staleGeneratedAlertIds } from "./reconcile";
import { formatInTimeZone } from "date-fns-tz";
import { isExpectedCostCategory } from "@/lib/expenses/expectedCosts";
import { summarizeVoidsRollups, isUnusualVoids } from "@/lib/calc/voidsReview";

/**
 * Generates alert rows from real data (docs/05-calculations.md "Alert rules"). Only 3 of the 6
 * documented rules are implemented — see PROGRESS.md decisions for why:
 *  - missing_bill, voids, meal_break: built here.
 *  - covered_milestone: needs last month's cost-recovery cover dates recomputed, not just this
 *    month's — real scope, deferred.
 *  - overstaffed_slot: needs an hour-of-week sales/staff-cost breakdown across 4 weeks — deferred.
 *  - early_clockin: needs scheduled shift start times, which no table in docs/04-data-model.md
 *    stores (timecards only have actual clock_in/out) — deferred, matching M2's own note.
 * Idempotent: re-running never creates a second open alert for the same underlying thing.
 */
export async function generateAlerts(supabase: SupabaseClient, businessId: string): Promise<{ created: number }> {
  // The demo tenant is shared by unrelated users. Reading is fine; generation is not.
  if (businessId === DEMO_BUSINESS_ID) return { created: 0 };
  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const timezone = business?.timezone ?? "America/Los_Angeles";
  let created = 0;
  created += await generateMissingBillAlerts(supabase, businessId, timezone);
  created += await generateVoidsAlert(supabase, businessId, timezone);
  created += await generateMealBreakAlerts(supabase, businessId, timezone);
  return { created };
}

/** Exported for `lib/actions/csvImport.ts`'s `unmatched_sales_items` alert, which is created right
 * at the moment an import finds the problem rather than in the batch pass below (it's tied to one
 * specific upload event, not something recomputable from steady-state data). */
export async function hasOpenAlert(
  supabase: SupabaseClient, businessId: string, kind: string, dedupeKey: string,
  includeReviewed = false,
): Promise<boolean> {
  // CSV imports retain open-only retries. Generated incidents suppress owner decisions,
  // but not automatic reconciliation when a corrected problem becomes actionable again.
  let query = supabase.from("alerts").select("id, payload, status")
    .eq("business_id", businessId).eq("kind", kind);
  if (!includeReviewed) query = query.in("status", ["new", "seen"]);
  const { data, error } = await query;
  // A failed dedupe read must not insert a duplicate OR crash the Alerts page.
  // Treat the occurrence as already present and let the next refresh retry.
  if (error) return true;
  return (data ?? []).some((a) => {
    const payload = a.payload as Record<string, unknown> | null;
    return payload?.dedupeKey === dedupeKey &&
      (!includeReviewed || blocksGeneratedAlert(a.status as "new" | "seen" | "resolved" | "dismissed", payload));
  });
}

async function generateMissingBillAlerts(supabase: SupabaseClient, businessId: string, timezone: string): Promise<number> {
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const monthKey = today.slice(0, 7);
  const monthStart = `${monthKey}-01`;
  const [year, month] = monthKey.split("-").map(Number);
  const prevMonth = new Date(year, month - 2, 1);
  const prevMonthKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}`;
  const prevMonthStart = `${prevMonthKey}-01`;
  const prevMonthEnd = new Date(year, month - 1, 0).toISOString().slice(0, 10);

  const [{ data: recurring }, { data: thisMonthExpenses }, { data: lastMonthExpenses }] = await Promise.all([
    supabase.from("recurring_costs").select("category_code").eq("business_id", businessId).is("active_to", null),
    supabase.from("expenses").select("category_code").eq("business_id", businessId).gte("spent_on", monthStart).lte("spent_on", today),
    supabase.from("expenses").select("category_code").eq("business_id", businessId).gte("spent_on", prevMonthStart).lte("spent_on", prevMonthEnd),
  ]);

  const hasRecurringSet = new Set((recurring ?? []).map((r) => r.category_code));
  const thisMonthSet = new Set((thisMonthExpenses ?? []).map((e) => e.category_code));
  const lastMonthSet = new Set((lastMonthExpenses ?? []).map((e) => e.category_code));

  let created = 0;
  const validKeys = new Set<string>();
  for (const code of RUNNING_COST_CODES) {
    const expected = isExpectedCostCategory(code, { hasActiveRecurring: hasRecurringSet.has(code), hadActualPreviousMonth: lastMonthSet.has(code) });
    const fires = expected && missingBillAlert({
      hasRecurring: hasRecurringSet.has(code),
      hadActualLastMonth: lastMonthSet.has(code),
      isMissingThisMonth: !thisMonthSet.has(code) && !hasRecurringSet.has(code),
    });
    if (!fires) continue;

    const dedupeKey = `${monthKey}-${code}`;
    validKeys.add(dedupeKey);
    if (await hasOpenAlert(supabase, businessId, "missing_bill", dedupeKey, true)) continue;

    await supabase.from("alerts").insert({
      business_id: businessId,
      kind: "missing_bill",
      impact_cents: null,
      payload: { dedupeKey, categoryCode: code, monthKey },
    });
    created += 1;
  }
  await resolveStaleGeneratedAlerts(supabase, businessId, "missing_bill", validKeys);
  return created;
}

async function generateVoidsAlert(supabase: SupabaseClient, businessId: string, timezone: string): Promise<number> {
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const monthKey = today.slice(0, 7);
  const [year, month] = monthKey.split("-").map(Number);
  const threeMonthsAgo = new Date(Date.UTC(year, month - 4, 1)).toISOString().slice(0, 10);

  const { data, error } = await supabase.from("daily_rollups")
    .select("business_date, voids_cents, sales_data_status, voids_status")
    .eq("business_id", businessId).gte("business_date", threeMonthsAgo)
    .lte("business_date", today).order("business_date", { ascending: true });
  // A failed read cannot prove a spike, and sales coverage never proves void coverage.
  if (error || !data) return 0;
  const summary = summarizeVoidsRollups(data.map(row => ({
    business_date: row.business_date,
    voids_cents: Number(row.voids_cents),
    sales_data_status: row.sales_data_status,
    // Only PR2-verified complete Toast void days may trigger a void alert.
    voidsCoverage: row.voids_status === "complete" ? "complete" as const : "unknown" as const,
  })), monthKey, today);

  const fires = isUnusualVoids(summary);

  // Resolve stale prior-month alerts and current false positives from missing coverage.
  // Owner-resolved/dismissed history stays immutable under resolveStaleGeneratedAlerts.
  await resolveStaleGeneratedAlerts(supabase, businessId, "voids",
    fires ? new Set([monthKey]) : new Set());
  if (!fires) return 0;

  const dedupeKey = monthKey;
  if (await hasOpenAlert(supabase, businessId, "voids", dedupeKey, true)) return 0;
  await supabase.from("alerts").insert({
    business_id: businessId, kind: "voids",
    impact_cents: summary.thisMonthCents,
    payload: {
      dedupeKey, monthKey,
      voidsThisMonthCents: summary.thisMonthCents,
      avgVoidsPrevious3MonthsCents: summary.previousThreeMonthAverageCents,
    },
  });
  return 1;
}

async function generateMealBreakAlerts(supabase: SupabaseClient, businessId: string, timezone: string): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: timecards } = await supabase
    .from("timecards")
    .select("id, employee_id, schedule_id, source_type, source_provider, clock_in, clock_out, hourly_wage_cents, breaks, employees(display_name)")
    .eq("business_id", businessId)
    .gte("clock_in", sevenDaysAgo);

  let created = 0;
  const validKeys = new Set<string>();
  for (const tc of timecards ?? []) {
    const status = mealBreakStatus(
      { clockIn: tc.clock_in, clockOut: tc.clock_out, hourlyWageCents: tc.hourly_wage_cents, breaks: tc.breaks ?? [], scheduleId: tc.schedule_id, sourceType: tc.source_type, sourceProvider: tc.source_provider },
      tc.clock_out ? new Date(tc.clock_out) : new Date(),
    );
    if (!status.missed) continue;

    const dedupeKey = tc.id;
    validKeys.add(dedupeKey);
    if (await hasOpenAlert(supabase, businessId, "meal_break", dedupeKey, true)) continue;

    const employee = tc.employees as unknown as { display_name: string } | { display_name: string }[] | null;
    const employeeName = Array.isArray(employee) ? employee[0]?.display_name : employee?.display_name;

    await supabase.from("alerts").insert({
      business_id: businessId,
      kind: "meal_break",
      impact_cents: status.penaltyCents,
      payload: { dedupeKey, timecardId: tc.id, employeeId: tc.employee_id, employeeName: employeeName ?? null, date: formatInTimeZone(tc.clock_in, timezone, "yyyy-MM-dd"), clockIn: tc.clock_in, clockOut: tc.clock_out, breaks: tc.breaks ?? [], reasonCode: "NO_QUALIFYING_30_MIN_BREAK_BY_HOUR_5", shiftHours: status.shiftHours, impactBasis: "ONE_HOUR_REGULAR_WAGE_ESTIMATE" },
    });
    created += 1;
  }
  await resolveStaleGeneratedAlerts(supabase, businessId, "meal_break", validKeys);
  return created;
}

async function resolveStaleGeneratedAlerts(supabase: SupabaseClient, businessId: string, kind: string, validKeys: Set<string>) {
  const { data } = await supabase.from("alerts").select("id, payload, status").eq("business_id", businessId).eq("kind", kind).in("status", ["new", "seen"]);
  const staleIds = staleGeneratedAlertIds((data ?? []).map((row) => ({ id: row.id, dedupeKey: String((row.payload as { dedupeKey?: string })?.dedupeKey ?? ""), status: row.status })), validKeys);
  if (staleIds.length > 0) await supabase.from("alerts").update({ status: "resolved" }).in("id", staleIds).in("status", ["new", "seen"]);
}
