import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromZonedTime } from "date-fns-tz";
import { recomputeDailyRollup } from "@/lib/pos/rollup";

/**
 * Auto-fills today's `timecards` from each employee's recurring schedule, for whoever doesn't
 * already have a row today (a manual entry, a POS sync, or an earlier materialization all count —
 * this only ever fills a genuine gap, never overwrites). This is what lets the owner not have to
 * log a normal day by hand: the schedule becomes today's actual hours the moment any page loads,
 * and every existing cost calculation reads the resulting `timecards` row exactly like any other.
 *
 * Cheap in the common case — one existence check per active schedule row — and only calls the
 * (more expensive) daily-rollup recompute when it actually inserted something, so a normal page
 * load on a day that's already materialized does no extra work beyond the lookups themselves.
 */
export async function ensureTodayScheduledShifts(
  supabase: SupabaseClient,
  businessId: string,
  timezone: string,
  todayDateStr: string,
): Promise<void> {
  // Day-of-week for `todayDateStr` (already the business's own local calendar date), computed
  // purely from its Y/M/D components via UTC construction + a UTC getter — never through the
  // server's own local timezone, which is exactly the UTC-vs-local mismatch this codebase has
  // been bitten by before (see runningCosts.ts's decision note).
  const [y, m, d] = todayDateStr.split("-").map(Number);
  const localDayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const { data: schedules } = await supabase
    .from("staff_schedules")
    .select("id, employee_id, start_time, end_time, unpaid_break_minutes, hourly_wage_cents, effective_from, effective_to")
    .eq("business_id", businessId)
    .eq("active", true)
    .eq("day_of_week", localDayOfWeek)
    .lte("effective_from", todayDateStr)
    .or(`effective_to.is.null,effective_to.gte.${todayDateStr}`);
  if (!schedules || schedules.length === 0) return;

  const dayStartUtc = fromZonedTime(`${todayDateStr}T00:00:00`, timezone).toISOString();
  const dayEndUtc = fromZonedTime(`${todayDateStr}T23:59:59.999`, timezone).toISOString();

  const { data: existing } = await supabase
    .from("timecards")
    .select("employee_id")
    .eq("business_id", businessId)
    .gte("clock_in", dayStartUtc)
    .lte("clock_in", dayEndUtc);
  const employeesAlreadyLogged = new Set((existing ?? []).map((r) => r.employee_id));

  const toInsert = schedules
    .filter((s) => !employeesAlreadyLogged.has(s.employee_id))
    .map((s) => {
      const clockInUtc = fromZonedTime(`${todayDateStr}T${s.start_time}`, timezone);
      let clockOutUtc = fromZonedTime(`${todayDateStr}T${s.end_time}`, timezone);
      if (clockOutUtc.getTime() <= clockInUtc.getTime()) {
        clockOutUtc = new Date(clockOutUtc.getTime() + 24 * 3_600_000); // crosses midnight
      }
      const breaks =
        s.unpaid_break_minutes > 0
          ? [
              {
                start: new Date(clockInUtc.getTime() + 4 * 3_600_000).toISOString(),
                end: new Date(clockInUtc.getTime() + 4 * 3_600_000 + s.unpaid_break_minutes * 60_000).toISOString(),
                paid: false,
              },
            ]
          : [];
      return {
        business_id: businessId,
        employee_id: s.employee_id,
        schedule_id: s.id,
        clock_in: clockInUtc.toISOString(),
        clock_out: clockOutUtc.toISOString(),
        hourly_wage_cents: s.hourly_wage_cents,
        breaks,
      };
    });
  if (toInsert.length === 0) return;

  const { error } = await supabase.from("timecards").insert(toInsert);
  if (error) return; // best-effort — a failed auto-fill shouldn't break the page that triggered it

  await recomputeDailyRollup(supabase, businessId, todayDateStr);
}
