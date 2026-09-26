import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mealBreakStatus, missingBillAlert, voidsAlert } from "@/lib/calc";
import { RUNNING_COST_CODES } from "@/lib/constants";

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
  let created = 0;
  created += await generateMissingBillAlerts(supabase, businessId);
  created += await generateVoidsAlert(supabase, businessId);
  created += await generateMealBreakAlerts(supabase, businessId);
  return { created };
}

async function hasOpenAlert(supabase: SupabaseClient, businessId: string, kind: string, dedupeKey: string): Promise<boolean> {
  const { data } = await supabase
    .from("alerts")
    .select("id, payload")
    .eq("business_id", businessId)
    .eq("kind", kind)
    .in("status", ["new", "seen"]);
  return (data ?? []).some((a) => (a.payload as { dedupeKey?: string })?.dedupeKey === dedupeKey);
}

async function generateMissingBillAlerts(supabase: SupabaseClient, businessId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
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
  for (const code of RUNNING_COST_CODES) {
    const fires = missingBillAlert({
      hasRecurring: hasRecurringSet.has(code),
      hadActualLastMonth: lastMonthSet.has(code),
      isMissingThisMonth: !thisMonthSet.has(code) && !hasRecurringSet.has(code),
    });
    if (!fires) continue;

    const dedupeKey = `${monthKey}-${code}`;
    if (await hasOpenAlert(supabase, businessId, "missing_bill", dedupeKey)) continue;

    await supabase.from("alerts").insert({
      business_id: businessId,
      kind: "missing_bill",
      impact_cents: null,
      payload: { dedupeKey, categoryCode: code, monthKey },
    });
    created += 1;
  }
  return created;
}

async function generateVoidsAlert(supabase: SupabaseClient, businessId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);
  const monthStart = `${monthKey}-01`;

  const { data: thisMonthRollups } = await supabase.from("daily_rollups").select("voids_cents").eq("business_id", businessId).gte("business_date", monthStart).lte("business_date", today);
  const voidsThisMonthCents = (thisMonthRollups ?? []).reduce((s, r) => s + r.voids_cents, 0);

  const [year, month] = monthKey.split("-").map(Number);
  const threeMonthsAgo = new Date(year, month - 4, 1).toISOString().slice(0, 10);
  const startOfThisMonth = monthStart;
  const { data: priorRollups } = await supabase.from("daily_rollups").select("voids_cents").eq("business_id", businessId).gte("business_date", threeMonthsAgo).lt("business_date", startOfThisMonth);
  const avgVoidsPrevious3MonthsCents = (priorRollups ?? []).reduce((s, r) => s + r.voids_cents, 0) / 3;

  if (!voidsAlert(voidsThisMonthCents, avgVoidsPrevious3MonthsCents)) return 0;

  const dedupeKey = monthKey;
  if (await hasOpenAlert(supabase, businessId, "voids", dedupeKey)) return 0;

  await supabase.from("alerts").insert({
    business_id: businessId,
    kind: "voids",
    impact_cents: voidsThisMonthCents,
    payload: { dedupeKey, monthKey, voidsThisMonthCents, avgVoidsPrevious3MonthsCents },
  });
  return 1;
}

async function generateMealBreakAlerts(supabase: SupabaseClient, businessId: string): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: timecards } = await supabase
    .from("timecards")
    .select("id, employee_id, clock_in, clock_out, hourly_wage_cents, breaks, employees(display_name)")
    .eq("business_id", businessId)
    .gte("clock_in", sevenDaysAgo);

  let created = 0;
  for (const tc of timecards ?? []) {
    const status = mealBreakStatus(
      { clockIn: tc.clock_in, clockOut: tc.clock_out, hourlyWageCents: tc.hourly_wage_cents, breaks: tc.breaks ?? [] },
      tc.clock_out ? new Date(tc.clock_out) : new Date(),
    );
    if (!status.missed) continue;

    const dedupeKey = tc.id;
    if (await hasOpenAlert(supabase, businessId, "meal_break", dedupeKey)) continue;

    const employee = tc.employees as unknown as { display_name: string } | { display_name: string }[] | null;
    const employeeName = Array.isArray(employee) ? employee[0]?.display_name : employee?.display_name;

    await supabase.from("alerts").insert({
      business_id: businessId,
      kind: "meal_break",
      impact_cents: status.penaltyCents,
      payload: { dedupeKey, timecardId: tc.id, employeeName: employeeName ?? null, date: tc.clock_in.slice(0, 10) },
    });
    created += 1;
  }
  return created;
}
