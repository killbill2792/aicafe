import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { generateAlerts } from "@/lib/alerts/generate";

export type AlertKind = "missing_bill" | "voids" | "meal_break" | "early_clockin" | "underpriced" | "overstaffed" | "covered_milestone" | "unmatched_sales_items";

export type AlertRow = {
  id: string;
  kind: AlertKind;
  impactCents: number | null;
  payload: Record<string, unknown>;
  status: "new" | "seen" | "resolved" | "dismissed";
  createdAt: string;
};

/** Regenerates alerts from current data, then returns the open ones. No cron yet (see
 * PROGRESS.md) — this is the trigger point until a scheduled job exists. */
export async function getOpenAlerts(): Promise<AlertRow[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);

  await generateAlerts(supabase, businessId);

  const { data } = await supabase
    .from("alerts")
    .select("id, kind, impact_cents, payload, status, created_at")
    .eq("business_id", businessId)
    .in("status", ["new", "seen"])
    .order("created_at", { ascending: false });

  return (data ?? []).map((a) => ({
    id: a.id,
    kind: a.kind as AlertKind,
    impactCents: a.impact_cents,
    payload: (a.payload as Record<string, unknown>) ?? {},
    status: a.status as AlertRow["status"],
    createdAt: a.created_at,
  }));
}

export async function getAlertById(id: string): Promise<AlertRow | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.from("alerts").select("id, kind, impact_cents, payload, status, created_at").eq("id", id).maybeSingle();
  if (!data) return null;

  return {
    id: data.id,
    kind: data.kind as AlertKind,
    impactCents: data.impact_cents,
    payload: (data.payload as Record<string, unknown>) ?? {},
    status: data.status as AlertRow["status"],
    createdAt: data.created_at,
  };
}
