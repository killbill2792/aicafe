"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";

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

/** Manually log one day's hours for an employee — the same `timecards` row shape a real POS sync
 * or CSV import writes, so every screen that reads staff cost (Staff tab, Menu's staff-time-per-
 * drink, Home) can't tell the difference. */
export async function logShift(input: z.infer<typeof ShiftSchema>): Promise<ActionResult> {
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
  const { error } = await supabase.from("timecards").insert({
    business_id: business.businessId,
    employee_id: parsed.data.employeeId,
    clock_in: clockInUtc.toISOString(),
    clock_out: clockOutUtc.toISOString(),
    hourly_wage_cents: parsed.data.hourlyWageCents,
    breaks,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/more/manage-staff");
  revalidatePath("/staff");
  revalidatePath("/");
  return { ok: true };
}
