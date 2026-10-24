import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { generateAlerts } from "@/lib/alerts/generate";
import { summarizeVoidsRollups, type VoidsSummary } from "@/lib/calc/voidsReview";
import { formatInTimeZone } from "date-fns-tz";

export type AlertKind = "missing_bill" | "voids" | "meal_break" | "early_clockin" | "underpriced" | "overstaffed" | "covered_milestone" | "unmatched_sales_items";

export type AlertRow = {
  id: string;
  kind: AlertKind;
  impactCents: number | null;
  payload: Record<string, unknown>;
  status: "new" | "seen" | "resolved" | "dismissed";
  createdAt: string;
  voidsReview?: { ok: true; summary: VoidsSummary } | { ok: false };
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);
  const { data } = await supabase.from("alerts")
    .select("id, kind, impact_cents, payload, status, created_at")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;

  const payload = (data.payload as Record<string, unknown>) ?? {};
  const voidsReview = data.kind === "voids"
    ? await readVoidsReview(supabase, businessId, payload.monthKey)
    : undefined;
  return {
    id: data.id,
    kind: data.kind as AlertKind,
    impactCents: data.impact_cents,
    payload,
    status: data.status as AlertRow["status"],
    createdAt: data.created_at,
    voidsReview,
  };
}

/** Private to this existing, inventoried alert-detail data source. */
async function readVoidsReview(
  db: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  payloadMonthKey: unknown,
): Promise<{ok:true;summary:VoidsSummary}|{ok:false}> {
  const { data: business, error: businessError } = await db.from("businesses")
    .select("timezone").eq("id", businessId).maybeSingle();
  if (businessError || !business?.timezone) return { ok: false };

  let today: string;
  try {
    today = formatInTimeZone(new Date(), business.timezone, "yyyy-MM-dd");
  } catch {
    return { ok: false };
  }
  const currentMonth = today.slice(0, 7);
  const monthKey = typeof payloadMonthKey === "string" &&
    /^\\d{4}-(0[1-9]|1[0-2])$/.test(payloadMonthKey) &&
    payloadMonthKey <= currentMonth
      ? payloadMonthKey : currentMonth;
  const [year, month] = monthKey.split("-").map(Number);
  const priorStart = new Date(Date.UTC(year, month - 4, 1)).toISOString().slice(0, 10);
  const nextMonthStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const endDate = monthKey === currentMonth ? today :
    new Date(Date.parse(`${nextMonthStart}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

  const { data, error } = await db.from("daily_rollups")
    .select("business_date, voids_cents, sales_data_status")
    .eq("business_id", businessId)
    .gte("business_date", priorStart)
    .lte("business_date", endDate)
    .order("business_date", { ascending: true });
  if (error || !data) return { ok: false };
  return { ok: true, summary: summarizeVoidsRollups(
    data.map((r) => ({business_date:r.business_date,voids_cents:Number(r.voids_cents),sales_data_status:r.sales_data_status})),
    monthKey,
  ) };
}
