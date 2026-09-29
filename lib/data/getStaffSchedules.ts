import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

export type StaffScheduleRow = {
  id: string;
  employeeId: string;
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  unpaidBreakMinutes: number;
  hourlyWageCents: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // null = ongoing/weekly
};

/** Every employee's current recurring schedule rows (Manage staff's weekly-schedule editor). */
export async function getStaffSchedules(): Promise<StaffScheduleRow[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);

  const { data } = await supabase
    .from("staff_schedules")
    .select("id, employee_id, day_of_week, start_time, end_time, unpaid_break_minutes, hourly_wage_cents, effective_from, effective_to")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("day_of_week", { ascending: true });

  return (data ?? []).map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    dayOfWeek: r.day_of_week,
    startTime: (r.start_time as string).slice(0, 5),
    endTime: (r.end_time as string).slice(0, 5),
    unpaidBreakMinutes: r.unpaid_break_minutes,
    hourlyWageCents: r.hourly_wage_cents,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  }));
}
