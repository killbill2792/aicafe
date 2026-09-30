import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import type { IngredientImportSummary, LaborImportSummary, SalesImportSummary } from "@/lib/actions/csvImport";

export type UploadHistoryRow = {
  id: string;
  kind: "sales_csv" | "labor_csv" | "ingredients_csv";
  status: "processing" | "needs_review" | "done" | "failed";
  createdAt: string;
  summary: SalesImportSummary | LaborImportSummary | IngredientImportSummary | null;
};

/** Every CSV import this business has ever run, newest first — lets an owner (or whoever's
 * helping her set this up) see what any past upload actually did instead of just a count that
 * vanished the moment they left the upload screen. */
export async function getUploadHistory(): Promise<UploadHistoryRow[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);

  const { data } = await supabase
    .from("uploads")
    .select("id, kind, status, summary, created_at")
    .eq("business_id", businessId)
    .in("kind", ["sales_csv", "labor_csv", "ingredients_csv"])
    .order("created_at", { ascending: false })
    .limit(50);

  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind as UploadHistoryRow["kind"],
    status: r.status as UploadHistoryRow["status"],
    createdAt: r.created_at,
    summary: (r.summary as UploadHistoryRow["summary"]) ?? null,
  }));
}
