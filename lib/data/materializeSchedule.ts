import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { recomputeDailyRollup } from "@/lib/pos/rollup";
import {
  localDatesInclusive,
  selectSchedulesForDate,
  type StaffScheduleMaterializationRow,
} from "./materializeScheduleRules";

function timecardRowFromSchedule(
  schedule: StaffScheduleMaterializationRow,
  businessId: string,
  date: string,
  timezone: string,
) {
  const clockInUtc = fromZonedTime(`${date}T${schedule.start_time}`, timezone);
  let clockOutUtc = fromZonedTime(`${date}T${schedule.end_time}`, timezone);
  if (clockOutUtc.getTime() <= clockInUtc.getTime()) {
    clockOutUtc = new Date(clockOutUtc.getTime() + 24 * 3_600_000);
  }

  const breaks =
    schedule.unpaid_break_minutes > 0
      ? [
          {
            start: new Date(clockInUtc.getTime() + 4 * 3_600_000).toISOString(),
            end: new Date(clockInUtc.getTime() + 4 * 3_600_000 + schedule.unpaid_break_minutes * 60_000).toISOString(),
            paid: false,
          },
        ]
      : [];

  return {
    business_id: businessId,
    employee_id: schedule.employee_id,
    schedule_id: schedule.id,
    expected_schedule_id: schedule.id,
    source_type: "owner_manual_schedule",
    source_provider: null,
    clock_in: clockInUtc.toISOString(),
    clock_out: clockOutUtc.toISOString(),
    hourly_wage_cents: schedule.hourly_wage_cents,
    breaks,
  };
}

/**
 * Materializes the owner's manually entered weekly schedules from the first day of the target
 * month through `throughDate`. Existing timecards always win, regardless of source, so this never
 * overwrites an owner-edited day, POS/imported attendance, or an earlier materialization.
 *
 * This deliberately does not create future timecards. Loading the app later advances the window.
 * The function is best-effort because snapshot reads should not fail just because schedule
 * reconciliation encountered a transient write error.
 */
export async function ensureScheduledShiftsThroughDate(
  supabase: SupabaseClient,
  businessId: string,
  timezone: string,
  throughDate: string,
): Promise<void> {
  const monthStart = `${throughDate.slice(0, 7)}-01`;
  const targetDates = localDatesInclusive(monthStart, throughDate);
  if (targetDates.length === 0) return;

  const { data: scheduleRows, error: schedulesError } = await supabase
    .from("staff_schedules")
    .select("id, employee_id, day_of_week, start_time, end_time, unpaid_break_minutes, hourly_wage_cents, effective_from, effective_to")
    .eq("business_id", businessId)
    .eq("active", true)
    .lte("effective_from", throughDate)
    .or(`effective_to.is.null,effective_to.gte.${monthStart}`);
  if (schedulesError || !scheduleRows || scheduleRows.length === 0) return;

  const dayStartUtc = fromZonedTime(`${monthStart}T00:00:00`, timezone).toISOString();
  const dayEndUtc = fromZonedTime(`${throughDate}T23:59:59.999`, timezone).toISOString();
  const { data: existingRows, error: existingError } = await supabase
    .from("timecards")
    .select("employee_id, clock_in")
    .eq("business_id", businessId)
    .gte("clock_in", dayStartUtc)
    .lte("clock_in", dayEndUtc);
  if (existingError) return;

  const existing = new Set(
    (existingRows ?? [])
      .filter((row) => row.employee_id)
      .map((row) => `${row.employee_id}:${formatInTimeZone(row.clock_in, timezone, "yyyy-MM-dd")}`),
  );

  const schedules = scheduleRows as StaffScheduleMaterializationRow[];
  const toInsert: ReturnType<typeof timecardRowFromSchedule>[] = [];
  const affectedDates = new Set<string>();

  for (const date of targetDates) {
    for (const schedule of selectSchedulesForDate(schedules, date)) {
      const key = `${schedule.employee_id}:${date}`;
      if (existing.has(key)) continue;
      toInsert.push(timecardRowFromSchedule(schedule, businessId, date, timezone));
      existing.add(key);
      affectedDates.add(date);
    }
  }

  if (toInsert.length === 0) return;
  const { error: insertError } = await supabase.from("timecards").insert(toInsert);
  if (insertError) return;

  await Promise.allSettled([...affectedDates].map((date) => recomputeDailyRollup(supabase, businessId, date)));
}

/** Backwards-compatible wrapper for older call sites. */
export async function ensureTodayScheduledShifts(
  supabase: SupabaseClient,
  businessId: string,
  timezone: string,
  todayDateStr: string,
): Promise<void> {
  return ensureScheduledShiftsThroughDate(supabase, businessId, timezone, todayDateStr);
}
