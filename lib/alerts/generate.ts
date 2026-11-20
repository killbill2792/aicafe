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
  const { data: business, error } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  if (error || !business?.timezone) throw new Error("alert_scope_unavailable");
  const outcomes = await Promise.allSettled([
    generateMissingBillAlerts(supabase, businessId, business.timezone),
    generateVoidsAlert(supabase, businessId, business.timezone),
    generateMealBreakAlerts(supabase, businessId, business.timezone),
  ]);
  if (outcomes.some(result => result.status === "rejected")) throw new Error("alert_refresh_incomplete");
  return { created: outcomes.reduce((total, result) => total + (result.status === "fulfilled" ? result.value : 0), 0) };
}

/** Exported for `lib/actions/csvImport.ts`'s `unmatched_sales_items` alert, which is created right
 * at the moment an import finds the problem rather than in the batch pass below (it's tied to one
 * specific upload event, not something recomputable from steady-state data). */
export async function hasOpenAlert(
  supabase: SupabaseClient, businessId: string, kind: string, dedupeKey: string,
  includeReviewed = false, strictRead = false,
): Promise<boolean> {
  // CSV imports retain open-only retries. Generated incidents suppress owner decisions,
  // but not automatic reconciliation when a corrected problem becomes actionable again.
  let query = supabase.from("alerts").select("id, payload, status")
    .eq("business_id", businessId).eq("kind", kind);
  if (!includeReviewed) query = query.in("status", ["new", "seen"]);
  const { data, error } = await query;
  // A failed dedupe read must not insert a duplicate OR crash the Alerts page.
  // Treat the occurrence as already present and let the next refresh retry.
  if (error) {
    if (strictRead) throw new Error("alert_dedupe_unavailable");
    return true;
  }
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

  const [recurringRead, currentRead, previousRead] = await Promise.all([
    supabase.from("recurring_costs").select("category_code").eq("business_id", businessId).is("active_to", null),
    supabase.from("expenses").select("category_code").eq("business_id", businessId).gte("spent_on", monthStart).lte("spent_on", today),
    supabase.from("expenses").select("category_code").eq("business_id", businessId).gte("spent_on", prevMonthStart).lte("spent_on", prevMonthEnd),
  ]);

  if ([recurringRead, currentRead, previousRead].some(read => read.error || !read.data))
    throw new Error("bill_source_unavailable");
  const hasRecurringSet = new Set((recurringRead.data ?? []).map((r) => r.category_code));
  const thisMonthSet = new Set((currentRead.data ?? []).map((e) => e.category_code));
  const lastMonthSet = new Set((previousRead.data ?? []).map((e) => e.category_code));

  let created = 0;
  const verifiedHealthyKeys = new Set<string>();
  for (const code of RUNNING_COST_CODES) {
    const expected = isExpectedCostCategory(code, { hasActiveRecurring: hasRecurringSet.has(code), hadActualPreviousMonth: lastMonthSet.has(code) });
    const fires = expected && missingBillAlert({
      hasRecurring: hasRecurringSet.has(code),
      hadActualLastMonth: lastMonthSet.has(code),
      isMissingThisMonth: !thisMonthSet.has(code) && !hasRecurringSet.has(code),
    });
    const dedupeKey = `${monthKey}-${code}`;
    if (!fires) {
      if (thisMonthSet.has(code) || hasRecurringSet.has(code)) verifiedHealthyKeys.add(dedupeKey);
      continue;
    }
    if (await hasOpenAlert(supabase, businessId, "missing_bill", dedupeKey, true, true)) continue;

    const { error } = await supabase.from("alerts").insert({
      business_id: businessId,
      kind: "missing_bill",
      impact_cents: null,
      payload: { dedupeKey, categoryCode: code, monthKey },
    });
    if (error) throw new Error("alert_insert_failed");
    created += 1;
  }
  await resolveStaleGeneratedAlerts(supabase, businessId, "missing_bill", verifiedHealthyKeys);
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
  if (error || !data) throw new Error("void_source_unavailable");
  const summary = summarizeVoidsRollups(data.map(row => ({
    business_date: row.business_date,
    voids_cents: row.voids_cents == null ? NaN : Number(row.voids_cents),
    sales_data_status: row.sales_data_status,
    // Only PR2-verified complete Toast void days may trigger a void alert.
    voidsCoverage: row.voids_status === "complete" ? "complete" as const : "unknown" as const,
  })), monthKey, today);

  const fires = isUnusualVoids(summary);

  // Unknown coverage or calendar rollover cannot establish recovery.
  if (summary.thisMonthCents === null || summary.previousThreeMonthAverageCents === null) return 0;
  if (!fires) {
    await resolveStaleGeneratedAlerts(supabase, businessId, "voids", new Set([monthKey]));
    return 0;
  }

  const dedupeKey = monthKey;
  if (await hasOpenAlert(supabase, businessId, "voids", dedupeKey, true, true)) return 0;
  const { error: insertError } = await supabase.from("alerts").insert({
    business_id: businessId, kind: "voids",
    impact_cents: summary.thisMonthCents,
    payload: {
      dedupeKey, monthKey,
      voidsThisMonthCents: summary.thisMonthCents,
      avgVoidsPrevious3MonthsCents: summary.previousThreeMonthAverageCents,
    },
  });
  if (insertError) throw new Error("alert_insert_failed");
  return 1;
}

async function generateMealBreakAlerts(supabase: SupabaseClient, businessId: string, timezone: string): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: timecards, error: readError } = await supabase
    .from("timecards")
    .select("id, employee_id, schedule_id, source_type, source_provider, clock_in, clock_out, hourly_wage_cents, breaks, employees(display_name)")
    .eq("business_id", businessId)
    .gte("clock_in", sevenDaysAgo);

  if (readError || !timecards) throw new Error("timecard_source_unavailable");
  let created = 0;
  const verifiedHealthyKeys = new Set<string>();
  for (const tc of timecards) {
    // Missing or malformed evidence is not proof of recovery.
    if (!Number.isFinite(Date.parse(tc.clock_in)) || (tc.clock_out && (!Number.isFinite(Date.parse(tc.clock_out)) || Date.parse(tc.clock_out) < Date.parse(tc.clock_in))) || !Array.isArray(tc.breaks)) continue;
    const status = mealBreakStatus(
      { clockIn: tc.clock_in, clockOut: tc.clock_out, hourlyWageCents: tc.hourly_wage_cents, breaks: tc.breaks ?? [], scheduleId: tc.schedule_id, sourceType: tc.source_type, sourceProvider: tc.source_provider },
      tc.clock_out ? new Date(tc.clock_out) : new Date(),
    );
    const dedupeKey = tc.id;
    if (!status.missed) {
      verifiedHealthyKeys.add(dedupeKey);
      continue;
    }
    if (await hasOpenAlert(supabase, businessId, "meal_break", dedupeKey, true, true)) continue;

    const employee = tc.employees as unknown as { display_name: string } | { display_name: string }[] | null;
    const employeeName = Array.isArray(employee) ? employee[0]?.display_name : employee?.display_name;

    const { error } = await supabase.from("alerts").insert({
      business_id: businessId,
      kind: "meal_break",
      impact_cents: status.penaltyCents,
      payload: { dedupeKey, timecardId: tc.id, employeeId: tc.employee_id, employeeName: employeeName ?? null, date: formatInTimeZone(tc.clock_in, timezone, "yyyy-MM-dd"), clockIn: tc.clock_in, clockOut: tc.clock_out, breaks: tc.breaks ?? [], reasonCode: "NO_QUALIFYING_30_MIN_BREAK_BY_HOUR_5", shiftHours: status.shiftHours, impactBasis: "ONE_HOUR_REGULAR_WAGE_ESTIMATE" },
    });
    if (error) throw new Error("alert_insert_failed");
    created += 1;
  }
  await resolveStaleGeneratedAlerts(supabase, businessId, "meal_break", verifiedHealthyKeys);
  return created;
}

async function resolveStaleGeneratedAlerts(supabase: SupabaseClient, businessId: string, kind: string, verifiedHealthyKeys: Set<string>) {
  if (!verifiedHealthyKeys.size) return;
  const { data, error } = await supabase.from("alerts").select("id, payload, status").eq("business_id", businessId).eq("kind", kind).in("status", ["new", "seen"]);
  if (error || !data) throw new Error("alert_reconcile_unavailable");
  const staleIds = staleGeneratedAlertIds((data ?? []).map((row) => ({ id: row.id, dedupeKey: String((row.payload as { dedupeKey?: string })?.dedupeKey ?? ""), status: row.status })), verifiedHealthyKeys);
  if (staleIds.length > 0) {
    const { error: updateError } = await supabase.from("alerts").update({ status: "resolved" }).eq("business_id", businessId).eq("kind", kind).in("id", staleIds).in("status", ["new", "seen"]);
    if (updateError) throw new Error("alert_reconcile_failed");
  }
}
