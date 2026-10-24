import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import type { IngredientImportSummary, LaborImportSummary, ProcessingFeeImportSummary, SalesImportSummary } from "@/lib/actions/csvImport";

export type UploadHistoryRow = {
  id: string;
  kind: "sales_csv" | "labor_csv" | "ingredients_csv" | "processing_fees_csv";
  status: "processing" | "needs_review" | "done" | "failed";
  createdAt: string;
  summary: SalesImportSummary | LaborImportSummary | IngredientImportSummary | ProcessingFeeImportSummary | null;
};

export type UploadReview = UploadHistoryRow & { jobId: string | null };

async function uploadContext() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);
  return { supabase, businessId };
}

const KINDS = ["sales_csv", "labor_csv", "ingredients_csv", "processing_fees_csv"];

function toHistoryRow(row: { id: string; kind: string; status: string; created_at: string; summary: unknown }): UploadHistoryRow {
  return {
    id: row.id,
    kind: row.kind as UploadHistoryRow["kind"],
    status: row.status as UploadHistoryRow["status"],
    createdAt: row.created_at,
    summary: row.summary as UploadHistoryRow["summary"] ?? null,
  };
}

/** Latest CSV uploads, always scoped to the signed-in café. */
export async function getUploadHistory(): Promise<UploadHistoryRow[]> {
  const ctx = await uploadContext();
  if (!ctx) return [];
  const { data, error } = await ctx.supabase.from("uploads")
    .select("id, kind, status, summary, created_at")
    .eq("business_id", ctx.businessId).in("kind", KINDS)
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).map(toHistoryRow);
}

/** A direct URL may never read another café's upload or its import job. */
export async function getUploadReview(uploadId: string): Promise<UploadReview | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(uploadId)) return null;
  const ctx = await uploadContext();
  if (!ctx) return null;
  const { data, error } = await ctx.supabase.from("uploads")
    .select("id, kind, status, summary, created_at")
    .eq("business_id", ctx.businessId).eq("id", uploadId)
    .in("kind", KINDS).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let jobId: string | null = null;
  if (data.kind === "sales_csv" || data.kind === "labor_csv") {
    const { data: job, error: jobError } = await ctx.supabase.from("csv_import_jobs")
      .select("id").eq("business_id", ctx.businessId).eq("upload_id", uploadId).maybeSingle();
    if (jobError) throw jobError;
    jobId = job?.id ?? null;
  }
  return { ...toHistoryRow(data), jobId };
}
