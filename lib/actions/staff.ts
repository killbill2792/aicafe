"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { recomputeDailyRollup } from "@/lib/pos/rollup";

export type ActionResult = { ok: true } | { ok: false; error: string };

async function currentBusiness(): Promise<{ businessId: string; timezone: string } | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);
  const { data } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  return { businessId, timezone: data?.timezone ?? "America/Los_Angeles" };
}

const EmployeeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(60).optional(),
  defaultHourlyWageCents: z.number().int().positive(),
});

/** Add one employee to the manual staff roster — for owners whose register plan doesn't export
 * a staff list (e.g. an unpaid Toast tier). The wage here is just a default that pre-fills the
 * "log hours" form; the wage of record for pay is still whatever's on each timecard, so a raise
 * doesn't rewrite history. */
export async function addEmployee(input: z.infer<typeof EmployeeSchema>): Promise<ActionResult> {
  const parsed = EmployeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name and hourly wage." };

  const business = await currentBusiness();
  if (!business) return { ok: false, error: "Sign in to add staff." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("employees").insert({
    business_id: business.businessId,
    display_name: parsed.data.name,
    role: parsed.data.role || null,
    default_hourly_wage_cents: parsed.data.defaultHourlyWageCents,
    active: true,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/more/manage-staff");
  return { ok: true };
}

const UpdateEmployeeSchema = z.object({
  employeeId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(60).optional(),
  defaultHourlyWageCents: z.number().int().positive(),
});

/** Edit an existing employee's name, role, and default wage — separate from logging a shift.
 * Past timecards keep whatever wage was on them at the time (see logShift), so this never
 * rewrites pay history; it only changes the roster entry and what pre-fills future shifts. */
export async function updateEmployee(input: z.infer<typeof UpdateEmployeeSchema>): Promise<ActionResult> {
  const parsed = UpdateEmployeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a name and hourly wage." };

  const business = await currentBusiness();
  if (!business) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("employees")
    .update({
      display_name: parsed.data.name,
      role: parsed.data.role || null,
      default_hourly_wage_cents: parsed.data.defaultHourlyWageCents,
    })
    .eq("id", parsed.data.employeeId)
    .eq("business_id", business.businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/more/manage-staff");
  revalidatePath("/staff");
  return { ok: true };
}

export async function setEmployeeActive(employeeId: string, active: boolean): Promise<ActionResult> {
  const business = await currentBusiness();
  if (!business) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("employees").update({ active }).eq("id", employeeId).eq("business_id", business.businessId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/more/manage-staff");
  return { ok: true };
}

const ShiftSchema = z.object({
  employeeId: z.string().uuid(),
  date: z.string(), // YYYY-MM-DD
  clockIn: z.string(), // HH:mm
  clockOut: z.string(), // HH:mm
  unpaidBreakMinutes: z.number().int().min(0).max(240),
  hourlyWageCents: z.number().int().positive(),
});

function dayBoundsUtc(date: string, timezone: string): { startIso: string; endIso: string } {
  return {
    startIso: fromZonedTime(`${date}T00:00:00`, timezone).toISOString(),
    endIso: fromZonedTime(`${date}T23:59:59.999`, timezone).toISOString(),
  };
}

export type ShiftForDay = {
  source: "confirmed" | "predicted" | "none";
  clockIn: string; // HH:mm
  clockOut: string; // HH:mm
  unpaidBreakMinutes: number;
  hourlyWageCents: number;
};

/** What's already true for one employee on one specific day — a real (confirmed) entry if one
 * exists, otherwise a preview of what the schedule would predict, otherwise nothing. Powers the
 * "edit a day" tool: opening any date shows what's actually there before changing it. */
export async function getShiftForDay(employeeId: string, date: string): Promise<ShiftForDay | null> {
  const business = await currentBusiness();
  if (!business) return null;

  const supabase = await createServerSupabaseClient();
  const { startIso, endIso } = dayBoundsUtc(date, business.timezone);

  const { data: timecard } = await supabase
    .from("timecards")
    .select("clock_in, clock_out, hourly_wage_cents, breaks, schedule_id")
    .eq("business_id", business.businessId)
    .eq("employee_id", employeeId)
    .gte("clock_in", startIso)
    .lte("clock_in", endIso)
    .maybeSingle();

  if (timecard) {
    const breakMinutes = ((timecard.breaks as { start: string; end: string; paid: boolean }[]) ?? [])
      .filter((b) => !b.paid)
      .reduce((sum, b) => sum + Math.round((new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000), 0);
    return {
      source: timecard.schedule_id ? "predicted" : "confirmed",
      clockIn: formatInTimeZone(timecard.clock_in, business.timezone, "HH:mm"),
      clockOut: formatInTimeZone(timecard.clock_out ?? timecard.clock_in, business.timezone, "HH:mm"),
      unpaidBreakMinutes: breakMinutes,
      hourlyWageCents: timecard.hourly_wage_cents,
    };
  }

  const [y, m, d] = date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const { data: schedule } = await supabase
    .from("staff_schedules")
    .select("start_time, end_time, unpaid_break_minutes, hourly_wage_cents")
    .eq("business_id", business.businessId)
    .eq("employee_id", employeeId)
    .eq("active", true)
    .eq("day_of_week", dayOfWeek)
    .lte("effective_from", date)
    .or(`effective_to.is.null,effective_to.gte.${date}`)
    .maybeSingle();

  if (schedule) {
    return {
      source: "predicted",
      clockIn: (schedule.start_time as string).slice(0, 5),
      clockOut: (schedule.end_time as string).slice(0, 5),
      unpaidBreakMinutes: schedule.unpaid_break_minutes,
      hourlyWageCents: schedule.hourly_wage_cents,
    };
  }

  return { source: "none", clockIn: "08:00", clockOut: "16:00", unpaidBreakMinutes: 30, hourlyWageCents: 0 };
}

/** Saves one employee's hours for one specific day — always the single row for that employee+day,
 * never a second one (an earlier version of this just inserted every time, so re-logging the same
 * day to fix a typo silently double-counted that day's cost). Clears `schedule_id` since this is
 * now an owner-confirmed entry, not an unconfirmed auto-fill from the schedule — same `timecards`
 * row shape a real POS sync or CSV import writes either way, so every cost calculation downstream
 * (Staff tab, Menu's staff-time-per-drink, Home, Money) can't tell the difference. */
export async function saveShiftForDay(input: z.infer<typeof ShiftSchema>): Promise<ActionResult> {
  const parsed = ShiftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the date, times, and wage." };

  const business = await currentBusiness();
  if (!business) return { ok: false, error: "Sign in to log hours." };

  const clockInUtc = fromZonedTime(`${parsed.data.date}T${parsed.data.clockIn}:00`, business.timezone);
  let clockOutUtc = fromZonedTime(`${parsed.data.date}T${parsed.data.clockOut}:00`, business.timezone);
  if (clockOutUtc.getTime() <= clockInUtc.getTime()) {
    // Crossed midnight (e.g. a closing shift 6pm–1am) — push clock-out to the next calendar day.
    clockOutUtc = new Date(clockOutUtc.getTime() + 24 * 3_600_000);
  }

  const breaks =
    parsed.data.unpaidBreakMinutes > 0
      ? [
          {
            start: new Date(clockInUtc.getTime() + 4 * 3_600_000).toISOString(),
            end: new Date(clockInUtc.getTime() + 4 * 3_600_000 + parsed.data.unpaidBreakMinutes * 60_000).toISOString(),
            paid: false,
          },
        ]
      : [];

  const supabase = await createServerSupabaseClient();
  const { startIso, endIso } = dayBoundsUtc(parsed.data.date, business.timezone);
  const { data: existing } = await supabase
    .from("timecards")
    .select("id")
    .eq("business_id", business.businessId)
    .eq("employee_id", parsed.data.employeeId)
    .gte("clock_in", startIso)
    .lte("clock_in", endIso)
    .maybeSingle();

  const row = {
    business_id: business.businessId,
    employee_id: parsed.data.employeeId,
    schedule_id: null,
    clock_in: clockInUtc.toISOString(),
    clock_out: clockOutUtc.toISOString(),
    hourly_wage_cents: parsed.data.hourlyWageCents,
    breaks,
  };
  const { error } = existing
    ? await supabase.from("timecards").update(row).eq("id", existing.id)
    : await supabase.from("timecards").insert(row);
  if (error) return { ok: false, error: error.message };

  await recomputeDailyRollup(supabase, business.businessId, parsed.data.date);

  revalidatePath("/more/manage-staff");
  revalidatePath("/staff");
  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  return { ok: true };
}

const AbsentSchema = z.object({
  employeeId: z.string().uuid(),
  date: z.string(),
});

/** Marks a day as a no-show — a zero-length shift at midnight so it costs nothing and no longer
 * looks unlogged (so the schedule won't auto-fill it again). */
export async function markDayAbsent(input: z.infer<typeof AbsentSchema>): Promise<ActionResult> {
  const parsed = AbsentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a day." };

  return saveShiftForDay({
    employeeId: parsed.data.employeeId,
    date: parsed.data.date,
    clockIn: "00:00",
    clockOut: "00:00",
    unpaidBreakMinutes: 0,
    hourlyWageCents: 1, // positive per ShiftSchema; contributes $0 since paid hours are 0
  });
}

const WeeklyScheduleDaySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string(), // HH:mm
  endTime: z.string(), // HH:mm
  unpaidBreakMinutes: z.number().int().min(0).max(240),
});

const SetWeeklyScheduleSchema = z.object({
  employeeId: z.string().uuid(),
  days: z.array(WeeklyScheduleDaySchema).max(7),
  hourlyWageCents: z.number().int().positive(),
  scope: z.union([z.object({ type: z.literal("ongoing") }), z.object({ type: z.literal("month"), month: z.string() })]),
});

/** Replaces an employee's recurring weekly schedule — "ongoing" (repeats every week until changed)
 * or bounded to one calendar month. Always replaces the whole set for that scope in one go, so
 * removing a day is just leaving it out of `days` rather than a separate delete step. */
export async function setWeeklySchedule(input: z.infer<typeof SetWeeklyScheduleSchema>): Promise<ActionResult> {
  const parsed = SetWeeklyScheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the days and times." };

  const business = await currentBusiness();
  if (!business) return { ok: false, error: "Sign in first." };

  const supabase = await createServerSupabaseClient();

  let effectiveFrom: string;
  let effectiveTo: string | null;
  if (parsed.data.scope.type === "month") {
    const [y, m] = parsed.data.scope.month.split("-").map(Number);
    effectiveFrom = `${parsed.data.scope.month}-01`;
    effectiveTo = `${parsed.data.scope.month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  } else {
    effectiveFrom = "1970-01-01";
    effectiveTo = null;
  }

  // Replace this employee's rows for the same scope (ongoing vs that specific month) — matched by
  // effective_from since it's set identically for every row of a given scope.
  const deleteQuery = supabase.from("staff_schedules").delete().eq("business_id", business.businessId).eq("employee_id", parsed.data.employeeId).eq("effective_from", effectiveFrom);
  const { error: deleteError } = effectiveTo === null ? await deleteQuery.is("effective_to", null) : await deleteQuery.eq("effective_to", effectiveTo);
  if (deleteError) return { ok: false, error: deleteError.message };

  if (parsed.data.days.length > 0) {
    const rows = parsed.data.days.map((d) => ({
      business_id: business.businessId,
      employee_id: parsed.data.employeeId,
      day_of_week: d.dayOfWeek,
      start_time: d.startTime,
      end_time: d.endTime,
      unpaid_break_minutes: d.unpaidBreakMinutes,
      hourly_wage_cents: parsed.data.hourlyWageCents,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      active: true,
    }));
    const { error: insertError } = await supabase.from("staff_schedules").insert(rows);
    if (insertError) return { ok: false, error: insertError.message };
  }

  revalidatePath("/more/manage-staff");
  return { ok: true };
}
