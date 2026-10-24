import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { summarizeVoidsRollups, type VoidsSummary } from "@/lib/calc/voidsReview";

export type VoidsReviewResult = { ok: true; summary: VoidsSummary } | { ok: false };

/** Selects only the signed-in owner's active café and only recorded void facts. */
export async function getVoidsReview(timezone: string, payloadMonthKey: unknown): Promise<VoidsReviewResult> {
  if (!isSupabaseConfigured()) return { ok: false };
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const currentMonth = today.slice(0, 7);
  const monthKey = typeof payloadMonthKey === "string" &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(payloadMonthKey) &&
    payloadMonthKey <= currentMonth
      ? payloadMonthKey : currentMonth;
  const [year, month] = monthKey.split("-").map(Number);
  const priorStart = new Date(Date.UTC(year, month - 4, 1)).toISOString().slice(0, 10);
  const nextMonthStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const endDate = monthKey === currentMonth ? today :
    new Date(Date.parse(`${nextMonthStart}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const db = await createServerSupabaseClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { ok: false };
  const businessId = await getActiveBusinessId(user.id);
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
