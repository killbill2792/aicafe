import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";

export type EmployeeRow = {
  id: string;
  name: string;
  role: string | null;
  defaultHourlyWageCents: number | null;
  active: boolean;
};

/** The manual staff roster (More → Manage staff) — for owners whose register plan doesn't export
 * a staff list, added directly rather than synced from a POS. */
export async function getEmployees(): Promise<EmployeeRow[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);

  const { data } = await supabase
    .from("employees")
    .select("id, display_name, role, default_hourly_wage_cents, active")
    .eq("business_id", businessId)
    .order("display_name", { ascending: true });

  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.display_name,
    role: r.role,
    defaultHourlyWageCents: r.default_hourly_wage_cents,
    active: r.active,
  }));
}
