"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { recomputeDailyRollup } from "@/lib/pos/rollup";
import { rebuildSalesFactRollups } from "@/lib/pos/salesFactRollups";
import { readStagedSalesGroups, readCsvFeeOrders, csvPromotedOrderId } from "@/lib/pos/csv/finalizeReads";
import { matchCatalogItem } from "@/lib/pos/catalogMatching";
import {inferMenuItemCategory} from "@/lib/menu/inferCategory";
import {recordInitialMenuPrice} from "@/lib/menu/priceHistory";
import { hasOpenAlert } from "@/lib/alerts/generate";
import { NEW_EMPLOYEE } from "@/lib/constants";
import { toCents } from "@/lib/pos/csv/csvUtils";
import type { AggregatedSalesRow } from "@/lib/pos/csv/aggregateSalesRows";
import type { SalesColumnMapping, SalesRejectReason } from "@/lib/pos/csv/parseSalesCsv";
import type { NormalizedLaborRow, LaborColumnMapping, LaborRejectReason } from "@/lib/pos/csv/parseLaborCsv";
import type { IngredientCostColumnMapping, NormalizedIngredientCostRow } from "@/lib/pos/csv/parseIngredientCostsCsv";
import { processingFeeTotalsByDate, type NormalizedProcessingFeeRow, type ProcessingFeeColumnMapping } from "@/lib/pos/csv/parseProcessingFeesCsv";
import { setProcessingFeeCandidateEligibility, upsertProcessingFeeDailyFact } from "@/lib/pos/processingFees";

type Kind = "sales" | "labor" | "ingredients" | "processing_fees";
type AnyMapping = SalesColumnMapping | LaborColumnMapping | IngredientCostColumnMapping | ProcessingFeeColumnMapping;
type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

// Sensible bounds so an unreasonable file fails fast and clearly instead of timing out silently.
const MAX_SOURCE_ROWS = 50_000;
const MAX_SALES_GROUPS = 5_000;
const MAX_LABOR_ROWS = 10_000;
const GROUP_INSERT_CHUNK_SIZE = 300;

/** Stable, localizable error identifiers — server actions never return English prose for an
 * owner-facing error; the UI looks each code up in next-intl message files (CsvImport.error*). */
export type ImportErrorCode =
  | "not_signed_in"
  | "row_limit_source"
  | "row_limit_groups"
  | "row_limit_shifts"
  | "no_valid_rows"
  | "already_processing_duplicate"
  | "already_running"
  | "create_job_failed"
  | "staging_failed"
  | "job_not_found"
  | "finalize_failed"
  | "wage_invalid"
  | "wage_update_failed"
  | "still_within_window";

type ActionError = { errorCode: ImportErrorCode; errorParams?: Record<string, string | number>; blockingJobId?: string };

function err(errorCode: ImportErrorCode, errorParams?: Record<string, string | number>, blockingJobId?: string): { ok: false } & ActionError {
  return { ok: false, errorCode, errorParams, blockingJobId };
}

export type RejectedRowSummary<R extends string> = { reason: R; count: number };
type LaborSummaryRejectReason = LaborRejectReason | "employee_creation_failed" | "duplicate_shift_in_file";

export type SalesImportSummary = {
  rowsInFile: number;
  imported: number;
  dateFrom: string | null;
  dateTo: string | null;
  unmatchedItems: { name: string; rows: number }[];
  rejectedRows: RejectedRowSummary<SalesRejectReason>[];
  skippedToastConflictDates: string[];
  duplicate?: boolean;
};
export type LaborImportSummary = {
  rowsInFile: number;
  imported: number;
  dateFrom: string | null;
  dateTo: string | null;
  rejectedRows: RejectedRowSummary<LaborSummaryRejectReason>[];
  pendingWageReview: { rowId: string; employee: string; clockInLabel: string; clockOutLabel: string | null }[];
  duplicate?: boolean;
};
export type IngredientImportSummary = { rowsInFile: number; imported: number; newIngredients: string[] };
export type ProcessingFeeImportSummary = { rowsInFile: number; importedDates: number; invalidRows: number; dateFrom: string | null; dateTo: string | null };

const processingFeeRowsSchema = z.array(z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actualProcessingFeeCents: z.number().int().nonnegative(),
})).max(10_000);

function dateRange(dates: string[]): { dateFrom: string | null; dateTo: string | null } {
  if (dates.length === 0) return { dateFrom: null, dateTo: null };
  const sorted = [...dates].sort();
  return { dateFrom: sorted[0], dateTo: sorted[sorted.length - 1] };
}

function csvSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Deterministic content fingerprint — same aggregated content always hashes the same, regardless
 * of row order in the source file, so a rolling-window re-export that overlaps a prior upload is
 * recognized as the same work rather than reprocessed or double-counted. */
function contentFingerprint(kind: Kind, payload: unknown): string {
  return createHash("sha256").update(kind).update(JSON.stringify(payload)).digest("hex");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function context() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const businessId = await getActiveBusinessId(user.id);
  return { supabase, businessId };
}

export async function getSavedMapping(kind: Kind): Promise<AnyMapping | null> {
  const ctx = await context();
  if (!ctx) return null;
  const { data } = await ctx.supabase.from("csv_import_mappings").select("column_mapping").eq("business_id", ctx.businessId).eq("kind", kind).maybeSingle();
  return (data?.column_mapping as AnyMapping) ?? null;
}

/** Read-only lookup for the saved upload link after an import completes. */
export async function getSalesImportUploadId(jobId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const ctx = await context();
  if (!ctx) return null;
  const { data, error } = await ctx.supabase.from("csv_import_jobs")
    .select("upload_id").eq("business_id", ctx.businessId).eq("kind", "sales")
    .eq("id", jobId).maybeSingle();
  if (error) return null;
  return data?.upload_id ?? null;
}

export async function saveMapping(kind: Kind, mapping: AnyMapping, sourceLabel?: string): Promise<{ ok: boolean; errorCode?: ImportErrorCode }> {
  const ctx = await context();
  if (!ctx) return { ok: false, errorCode: "not_signed_in" };
  const { error } = await ctx.supabase
    .from("csv_import_mappings")
    .upsert({ business_id: ctx.businessId, kind, column_mapping: mapping, source_label: sourceLabel }, { onConflict: "business_id,kind" });
  return error ? { ok: false, errorCode: "staging_failed" } : { ok: true };
}

async function findDuplicateJob(supabase: SupabaseServerClient, businessId: string, kind: Kind, fingerprint: string) {
  const { data } = await supabase
    .from("csv_import_jobs")
    .select("id, status, summary")
    .eq("business_id", businessId)
    .eq("kind", kind)
    .eq("content_fingerprint", fingerprint)
    .neq("status", "failed")
    .maybeSingle();
  return data;
}

async function findActiveJobId(supabase: SupabaseServerClient, businessId: string, kind: Kind): Promise<string | undefined> {
  const { data } = await supabase.from("csv_import_jobs").select("id").eq("business_id", businessId).eq("kind", kind).eq("status", "processing").maybeSingle();
  return data?.id;
}

/** The DB atomically updates both the job status and its Upload History row. A failed
 * insert/link/update throws so the caller cannot report successful completion with stale history. */
async function upsertUploadHistory(
  supabase: SupabaseServerClient,
  job: { id: string; business_id: string; upload_id: string | null },
  uploadKind: "sales_csv" | "labor_csv",
  status: "done" | "needs_review",
  summary: SalesImportSummary | LaborImportSummary,
): Promise<void> {
  const jobStatus = status === "done" ? "done" : uploadKind === "labor_csv" ? "needs_wage_review" : "needs_review";
  const { error } = await supabase.rpc("csv_complete_import_with_history", {
    p_job_id: job.id,
    p_upload_kind: uploadKind,
    p_job_status: jobStatus,
    p_summary: summary,
  });
  if (error) throw error;
}

/** Resolves each distinct item name to a menu_item (lib/pos/catalogMatching.ts, unchanged), run
 * once over the aggregated (deduped) item set rather than once per source row. Mutates
 * menu_items/pos_catalog_matches, so callers must only invoke this AFTER the job's active-unique
 * lock row is already inserted — otherwise a losing concurrent call could still mutate the catalog
 * even though its own import never started. */
async function resolveMenuItemIds(
  supabase: SupabaseServerClient,
  businessId: string,
  groups: AggregatedSalesRow[],
): Promise<{ menuItemIdByName: Map<string, string>; unmatchedItems: { name: string; rows: number }[] }> {
  const { data: menuItems } = await supabase.from("menu_items").select("id, name, size_label, price_cents, category, pos_item_id").eq("business_id", businessId);
  const candidates = (menuItems ?? []).map((item) => ({ id: item.id, name: item.name, sizeLabel: item.size_label, priceCents: item.price_cents, category: item.category, posItemId: item.pos_item_id }));
  const menuItemIdByName = new Map<string, string>();
  const unmatchedRowsByName = new Map<string, number>();

  for (const name of [...new Set(groups.map((g) => g.item))]) {
    const observations=groups.filter(g=>g.item===name&&g.quantity>0)
      .map(g=>Math.round(g.netSalesCents/g.quantity)).filter(v=>Number.isSafeInteger(v)&&v>0)
      .sort((a,b)=>a-b);
    const middle=Math.floor(observations.length/2);
    const priceCents=observations.length===0?null:observations.length%2?observations[middle]:
      Math.round((observations[middle-1]+observations[middle])/2);
    const posItemId = `csv-item-${csvSlug(name)}`.slice(0, 120);
    const match = matchCatalogItem({ posItemId, name, priceCents, category: null }, candidates);
    if (match.status === "matched" && match.candidateId) {
      menuItemIdByName.set(name.toLowerCase(), match.candidateId);
      await supabase.from("menu_items").update({ pos_item_id: posItemId, catalog_source: "csv", catalog_last_synced_at: new Date().toISOString() }).eq("id", match.candidateId).eq("business_id", businessId);
    } else if (match.status === "new") {
      const { data: created } = await supabase.from("menu_items").insert({ business_id: businessId, pos_item_id: posItemId, name, base_name: name, price_cents: priceCents, category: inferMenuItemCategory(name), catalog_source: "csv", catalog_last_synced_at: new Date().toISOString() }).select("id").single();
      if (created){
        menuItemIdByName.set(name.toLowerCase(), created.id);
        if(priceCents!==null)await recordInitialMenuPrice(supabase,{businessId,menuItemId:created.id,priceCents,sourceProvider:"csv import estimate"});
      }
    } else {
      await supabase.from("pos_catalog_matches").upsert({ business_id: businessId, provider: "csv", pos_item_id: posItemId, imported_name: name, imported_price_cents: priceCents, suggested_menu_item_id: match.candidateId, match_score: match.score, status: "needs_review" }, { onConflict: "business_id,provider,pos_item_id" });
      const rows = groups.filter((g) => g.item === name).reduce((s, g) => s + g.sourceRowCount, 0);
      unmatchedRowsByName.set(name, rows);
    }
  }

  return { menuItemIdByName, unmatchedItems: [...unmatchedRowsByName.entries()].map(([name, rows]) => ({ name, rows })) };
}

/** When a duplicate (identical-content) sales upload matches a `needs_review` job that still has
 * unmatched items, re-checks whether those item names now resolve (the owner may have matched them
 * through Menu's import-review screen since the first upload) and, if so, backfills BOTH the
 * staged group and the already-promoted canonical `order_lines` directly — the previous row-by-row
 * importer effectively did this for free by fully rewriting order_lines on every re-upload; the new
 * duplicate short-circuit must not silently remove that recovery path. */
async function reconcileUnresolvedSalesItems(supabase: SupabaseServerClient, businessId: string, job: { id: string; summary: unknown }) {
  const summary = job.summary as SalesImportSummary | null;
  if (!summary || summary.unmatchedItems.length === 0) return summary;

  const { data: unresolvedGroups } = await supabase.from("csv_sales_import_groups").select("item_name").eq("job_id", job.id).is("menu_item_id", null);
  const stillUnmatchedNames = [...new Set((unresolvedGroups ?? []).map((g) => g.item_name as string))];
  if (stillUnmatchedNames.length === 0) return summary;

  const { data: menuItems } = await supabase.from("menu_items").select("id, name, pos_item_id").eq("business_id", businessId);
  const byPosItemId = new Map((menuItems ?? []).map((m) => [m.pos_item_id, m.id]));

  const { data: csvOrders } = await supabase.from("orders").select("id").eq("business_id", businessId).like("pos_order_id", "csv-%");
  const csvOrderIds = (csvOrders ?? []).map((o) => o.id);

  const resolvedNames = new Set<string>();
  for (const name of stillUnmatchedNames) {
    const posItemId = `csv-item-${csvSlug(name)}`.slice(0, 120);
    const menuItemId = byPosItemId.get(posItemId);
    if (!menuItemId) continue;
    await supabase.from("csv_sales_import_groups").update({ menu_item_id: menuItemId }).eq("job_id", job.id).eq("item_name", name).is("menu_item_id", null);
    if (csvOrderIds.length > 0) {
      await supabase.from("order_lines").update({ menu_item_id: menuItemId }).eq("name", name).is("menu_item_id", null).in("order_id", csvOrderIds);
    }
    resolvedNames.add(name);
  }
  if (resolvedNames.size === 0) return summary;

  const unmatchedItems = summary.unmatchedItems.filter((u) => !resolvedNames.has(u.name));
  const updatedSummary: SalesImportSummary = { ...summary, unmatchedItems };
  const finalStatus = unmatchedItems.length === 0 && summary.skippedToastConflictDates.length === 0 && summary.rejectedRows.length === 0 ? "done" : "needs_review";
  const { data: fullJob } = await supabase.from("csv_import_jobs").select("id, business_id, upload_id").eq("id", job.id).single();
  if (fullJob) await upsertUploadHistory(supabase, fullJob, "sales_csv", finalStatus, updatedSummary);
  revalidatePath("/menu");
  revalidatePath("/money");
  return updatedSummary;
}

/** Starts a sales import job: acquires the one-active-job lock, THEN resolves menu items over the
 * deduped item set (so a losing concurrent call never mutates the catalog), then stages the bounded
 * group list. Takes already-aggregated groups (lib/pos/csv/aggregateSalesRows.ts, run client-side
 * BEFORE this call) rather than raw per-selection rows — the point of aggregating client-side is to
 * keep this request's payload bounded by distinct (date, item, category) groups, not by a
 * potentially-thousands-of-rows source file; aggregating again server-side from the full row array
 * would defeat that and risk the request body limit on a large file. Returns a jobId for
 * `finalizeSalesImportJob` to promote atomically — split from this step so neither call does
 * unbounded row-by-row DB work. */
export async function startSalesImportJob(
  groups: AggregatedSalesRow[],
  rowsInFile: number,
  rejectedRows: RejectedRowSummary<SalesRejectReason>[],
): Promise<{ ok: boolean; jobId?: string; duplicate?: boolean; summary?: SalesImportSummary } & Partial<ActionError>> {
  const ctx = await context();
  if (!ctx) return err("not_signed_in");
  const { supabase, businessId } = ctx;

  if (rowsInFile > MAX_SOURCE_ROWS) return err("row_limit_source", { count: rowsInFile, limit: MAX_SOURCE_ROWS });
  if (groups.length > MAX_SALES_GROUPS) return err("row_limit_groups", { count: groups.length, limit: MAX_SALES_GROUPS });
  if (groups.length === 0) return err("no_valid_rows");

  // Rejected-row content is part of the job's identity: a corrected re-upload that fixes malformed
  // rows but keeps the same valid sales groups must not be treated as the exact same prior upload.
  const fingerprint = contentFingerprint("sales", { groups, rowsInFile, rejectedRows });
  const existingJob = await findDuplicateJob(supabase, businessId, "sales", fingerprint);
  if (existingJob) {
    if (existingJob.status === "processing") return err("already_processing_duplicate");
    const reconciled = existingJob.status === "needs_review" ? await reconcileUnresolvedSalesItems(supabase, businessId, existingJob) : (existingJob.summary as SalesImportSummary | null);
    return { ok: true, duplicate: true, jobId: existingJob.id, summary: reconciled ? { ...reconciled, duplicate: true } : undefined };
  }

  const seedSummary: SalesImportSummary = { rowsInFile, imported: 0, dateFrom: null, dateTo: null, unmatchedItems: [], rejectedRows, skippedToastConflictDates: [] };
  const { dateFrom, dateTo } = dateRange(groups.map((g) => g.date));
  const { data: job, error: jobError } = await supabase
    .from("csv_import_jobs")
    .insert({
      business_id: businessId,
      kind: "sales",
      status: "processing",
      content_fingerprint: fingerprint,
      rows_in_file: rowsInFile,
      group_count: groups.length,
      summary: seedSummary,
      date_from: dateFrom,
      date_to: dateTo,
    })
    .select("id")
    .single();

  if (jobError || !job) {
    if (jobError?.code === "23505" && jobError.message.includes("csv_import_jobs_active_unique")) {
      return err("already_running", undefined, await findActiveJobId(supabase, businessId, "sales"));
    }
    if (jobError?.code === "23505") {
      const retry = await findDuplicateJob(supabase, businessId, "sales", fingerprint);
      if (retry) return { ok: true, duplicate: true, jobId: retry.id, summary: retry.summary as SalesImportSummary };
    }
    return err("create_job_failed");
  }

  // Only now (lock held) do we touch shared catalog state.
  const { data: locationRow } = await supabase.from("locations").select("id").eq("business_id", businessId).limit(1).maybeSingle();
  const { menuItemIdByName, unmatchedItems } = await resolveMenuItemIds(supabase, businessId, groups);

  const stagingRows = groups.map((g) => ({
    job_id: job.id,
    business_id: businessId,
    location_id: locationRow?.id ?? null,
    business_date: g.date,
    item_name: g.item,
    category: g.category,
    menu_item_id: menuItemIdByName.get(g.item.toLowerCase()) ?? null,
    quantity: g.quantity,
    net_sales_cents: g.netSalesCents,
    processing_fee_cents: g.processingFeeCents,
    processing_fee_status: g.processingFeeStatus,
    source_row_count: g.sourceRowCount,
  }));

  for (const batch of chunk(stagingRows, GROUP_INSERT_CHUNK_SIZE)) {
    const { error } = await supabase.from("csv_sales_import_groups").insert(batch);
    if (error) {
      await supabase.from("csv_import_jobs").update({ status: "failed", error_message: error.message, updated_at: new Date().toISOString() }).eq("id", job.id);
      return err("staging_failed");
    }
  }

  await supabase.from("csv_import_jobs").update({ summary: { ...seedSummary, unmatchedItems }, updated_at: new Date().toISOString() }).eq("id", job.id);

  return { ok: true, jobId: job.id, summary: { ...seedSummary, unmatchedItems } };
}

/** Promotes every staged group for a job into canonical orders/order_lines in one atomic SQL
 * transaction (`csv_finalize_sales_job`), then recomputes fees/rollups/alerts for affected dates —
 * the exact same per-date logic the old row-by-row importer used, just run once the atomic write
 * is already done rather than interleaved with it. Safe to call again if a prior call failed
 * partway (status `failed`) or is still `processing`: the RPC only processes groups not yet marked
 * `promoted`. A `done`/`needs_review` job (already fully finalized) short-circuits to its stored
 * result instead of re-running — but `failed` never does, so a genuine failure is always retryable. */
export async function finalizeSalesImportJob(jobId: string): Promise<{ ok: boolean; imported?: number; summary?: SalesImportSummary } & Partial<ActionError>> {
  const ctx = await context();
  if (!ctx) return err("not_signed_in");
  const { supabase, businessId } = ctx;

  const { data: job } = await supabase.from("csv_import_jobs").select("*").eq("id", jobId).eq("business_id", businessId).single();
  if (!job) return { ok: false, imported: 0, errorCode: "job_not_found" };
  if (job.status === "done" || job.status === "needs_review") {
    return { ok: true, imported: (job.summary as SalesImportSummary | null)?.imported ?? 0, summary: job.summary as SalesImportSummary };
  }

  const { error: rpcError } = await supabase.rpc("csv_finalize_sales_job", { p_job_id: jobId });
  if (rpcError) {
    await supabase.from("csv_import_jobs").update({ status: "failed", error_message: rpcError.message, updated_at: new Date().toISOString() }).eq("id", jobId);
    return { ok: false, imported: 0, errorCode: "finalize_failed" };
  }

  // Fail closed if any page is unavailable: SQL may have promoted more than
  // 1,000 groups and finalization must not mark missing categories as complete.
  const groups = await readStagedSalesGroups(supabase, businessId, jobId);
  const promotedGroups = groups.filter((g) => g.conflict_reason !== "toast_covers_date");
  const affectedDates = [...new Set(promotedGroups.map((g) => g.business_date as string))];
  const skippedToastConflictDates = [...new Set(groups.filter((g) => g.conflict_reason === "toast_covers_date").map((g) => g.business_date as string))];

  // Preserve staged category on canonical CSV lines; never invent customer facts.
  for(const g of promotedGroups) {
    const key=csvPromotedOrderId(g.business_date,g.item_name,g.category);
    const {data:order,error:lookupError}=await supabase.from("orders").select("id")
      .eq("business_id",businessId).eq("pos_order_id",key).maybeSingle();
    if(lookupError)throw lookupError;
    if(order) {
      const {error:lineError}=await supabase.from("order_lines")
        .update({category:g.category??null}).eq("order_id",order.id).eq("name",g.item_name);
      if(lineError)throw lineError;
    }
  }
  const unmatchedCounts = new Map<string, number>();
  for (const g of groups) {
    if (!g.menu_item_id && g.conflict_reason !== "toast_covers_date") {
      unmatchedCounts.set(g.item_name as string, (unmatchedCounts.get(g.item_name as string) ?? 0) + (g.source_row_count as number));
    }
  }

  for (const date of affectedDates) {
    const feeOrders = await readCsvFeeOrders(supabase, businessId, date);
    if (feeOrders.length > 0 && feeOrders.every((order) => order.processing_fee_status === "actual")) {
      await upsertProcessingFeeDailyFact(supabase, {
        businessId,
        businessDate: date,
        amountCents: feeOrders.reduce((sum, order) => sum + Number(order.processing_fee_cents), 0),
        status: "actual",
        sourceType: "manual_actual",
        provider: "csv",
        sourceReference: `sales-csv:${date}`,
      });
    } else {
      await setProcessingFeeCandidateEligibility(supabase, { businessId, businessDate: date, sourceType: "manual_actual", provider: "csv", eligible: false });
    }
    await recomputeDailyRollup(supabase, businessId, date, { salesDataStatus: "actual" });
  }

  const {data:businessRow,error:tzError}=await supabase.from("businesses").select("timezone").eq("id",businessId).single();
  if(tzError)throw tzError;
  await rebuildSalesFactRollups(supabase,businessId,affectedDates,businessRow.timezone);

  const unmatchedItems = [...unmatchedCounts.entries()].map(([name, rows]) => ({ name, rows }));
  const rejectedRows = (job.summary as SalesImportSummary | null)?.rejectedRows ?? [];
  const summary: SalesImportSummary = {
    rowsInFile: job.rows_in_file,
    imported: promotedGroups.length,
    ...dateRange(affectedDates),
    unmatchedItems,
    rejectedRows,
    skippedToastConflictDates,
  };

  const hasIssues = unmatchedItems.length > 0 || skippedToastConflictDates.length > 0 || rejectedRows.length > 0;
  const finalStatus = hasIssues ? "needs_review" : "done";
  try {
    await upsertUploadHistory(supabase, job, "sales_csv", finalStatus, summary);
  } catch {
    await supabase.from("csv_import_jobs").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", jobId).eq("business_id", businessId);
    return err("finalize_failed");
  }

  if (unmatchedItems.length > 0) {
    const dedupeKey = [...unmatchedCounts.keys()].sort().join("|");
    if (!(await hasOpenAlert(supabase, businessId, "unmatched_sales_items", dedupeKey))) {
      await supabase.from("alerts").insert({
        business_id: businessId,
        kind: "unmatched_sales_items",
        impact_cents: null,
        payload: { dedupeKey, itemNames: [...unmatchedCounts.keys()], rowCount: unmatchedItems.reduce((s, u) => s + u.rows, 0) },
      });
    }
  }

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  revalidatePath("/more/alerts");
  revalidatePath("/more/uploads/history");
  return { ok: true, imported: promotedGroups.length, summary };
}

// How long a job must sit untouched before it's considered abandoned rather than genuinely still
// running. This is a wall-clock floor on `updated_at`, not real liveness evidence (there is no
// heartbeat/lease — each finalize call only touches the row at the very start and very end of its
// own work) — widened well past this import's normal bounded runtime (seconds, by design: staging
// and promotion are both bounded by group/row count, not raw file size) specifically so this can't
// plausibly race a call that is still actually in flight.
const STUCK_JOB_THRESHOLD_MS = 30 * 60 * 1000;

/** Cancels an import job that's sat in `processing` untouched for 30+ minutes — the recovery path
 * when a browser closed or crashed between `startSalesImportJob`/`startLaborImportJob` and the
 * matching finalize call, which would otherwise hold the one-active-job-per-business+kind lock
 * forever. Checks `updated_at`, not `created_at` — a prior failed attempt that got partway and was
 * retried bumps `updated_at`, so this measures time since the row was LAST touched, not since the
 * job was first created. */
export async function cancelStuckImportJob(jobId: string): Promise<{ ok: boolean } & Partial<ActionError>> {
  const ctx = await context();
  if (!ctx) return err("not_signed_in");
  const { supabase, businessId } = ctx;
  const { data, error } = await supabase
    .from("csv_import_jobs")
    .update({ status: "failed", error_message: "Cancelled after being stuck in processing.", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("business_id", businessId)
    .eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - STUCK_JOB_THRESHOLD_MS).toISOString())
    .select("id")
    .maybeSingle();
  if (error) return err("staging_failed");
  if (!data) return err("still_within_window");
  return { ok: true };
}

/** Resolves each distinct CSV employee name to a real `employees.id`, in three tiers — never
 * guessing when a name is genuinely ambiguous:
 *  1. Remembered: an employee already has `pos_team_member_id = csv-<slug>` from a prior
 *     resolution (this upload or an earlier one) — use them, no owner input needed.
 *  2. Confident: exactly one employee's `display_name` matches case-insensitively — use them, and
 *     backfill `pos_team_member_id` so tier 1 catches it immediately next time.
 *  3. Ambiguous (zero or 2+ name matches, e.g. "Jose" vs. "Jose Sanchez," or two people both named
 *     "Jose"): use `employeeChoices[name]` (an existing id, or `NEW_EMPLOYEE`) from the owner's
 *     review step — same backfill either way, so this name is remembered going forward too.
 * Returns the resolved id per original (non-lowercased) name; a name missing from the result means
 * its `employees` insert failed and the caller must treat those rows as rejected, not silently
 * dropped. */
async function resolveEmployeeIds(
  supabase: SupabaseServerClient,
  businessId: string,
  names: string[],
  employeeChoices: Record<string, string>,
): Promise<Map<string, string>> {
  const { data: employeeRows } = await supabase.from("employees").select("id, display_name, pos_team_member_id").eq("business_id", businessId);
  const employees = employeeRows ?? [];

  const resolved = new Map<string, string>();
  for (const name of names) {
    const slug = csvSlug(name);
    const posId = `csv-${slug}`.slice(0, 120);

    const remembered = employees.find((e) => e.pos_team_member_id === posId);
    if (remembered) {
      resolved.set(name, remembered.id);
      continue;
    }

    const nameMatches = employees.filter((e) => e.display_name.trim().toLowerCase() === name.trim().toLowerCase());
    let employeeId: string | undefined;
    if (nameMatches.length === 1) {
      employeeId = nameMatches[0].id;
    } else {
      const choice = employeeChoices[name.trim().toLowerCase()];
      if (choice && choice !== NEW_EMPLOYEE) employeeId = choice;
    }

    if (!employeeId) {
      const { data: created } = await supabase.from("employees").insert({ business_id: businessId, display_name: name, pos_team_member_id: posId, active: true }).select("id").single();
      if (!created) continue;
      employeeId = created.id;
      employees.push({ id: created.id, display_name: name, pos_team_member_id: posId });
    } else {
      await supabase.from("employees").update({ pos_team_member_id: posId }).eq("id", employeeId);
    }
    if (!employeeId) continue;
    resolved.set(name, employeeId);
  }
  return resolved;
}

/** Starts a labor import job. Each row is a distinct shift (no aggregation, unlike sales) staged
 * with its resolved employee and — when the file has no wage column, or a row's wage cell is
 * blank/unparseable — a null `hourlyWageCents`. A null wage never blocks staging the shift's actual
 * clock-in/out evidence; it only blocks that one row from promoting into payroll-affecting
 * `timecards` until the owner supplies a rate (`resolveLaborImportWage`). Employee resolution (and
 * its `employeeChoices` corrections) runs AFTER the job lock is acquired, and any name whose
 * `employees` row could not be created is tracked as a rejected row instead of silently vanishing
 * from the staged count. */
export async function startLaborImportJob(
  rows: NormalizedLaborRow[],
  employeeChoices: Record<string, string>,
  rowsInFile: number,
  rejectedRows: RejectedRowSummary<LaborRejectReason>[],
): Promise<{ ok: boolean; jobId?: string; duplicate?: boolean; summary?: LaborImportSummary } & Partial<ActionError>> {
  const ctx = await context();
  if (!ctx) return err("not_signed_in");
  const { supabase, businessId } = ctx;

  if (rowsInFile > MAX_SOURCE_ROWS) return err("row_limit_source", { count: rowsInFile, limit: MAX_SOURCE_ROWS });
  if (rows.length > MAX_LABOR_ROWS) return err("row_limit_shifts", { count: rows.length, limit: MAX_LABOR_ROWS });
  if (rows.length === 0) return err("no_valid_rows");

  // employeeChoices is part of the identity: correcting an ambiguous name's match and re-uploading
  // the same rows must not be treated as the same prior (possibly wrong) result. rowsInFile and
  // rejectedRows are included too — a corrected re-upload that fixes malformed rows but keeps the
  // same valid shifts must not be treated as the exact same prior upload.
  const fingerprintPayload = {
    rows: [...rows].sort((a, b) => (a.employee === b.employee ? a.clockIn.localeCompare(b.clockIn) : a.employee.localeCompare(b.employee))),
    employeeChoices: Object.fromEntries(Object.entries(employeeChoices).sort(([a], [b]) => a.localeCompare(b))),
    rowsInFile,
    rejectedRows,
  };
  const fingerprint = contentFingerprint("labor", fingerprintPayload);
  const existingJob = await findDuplicateJob(supabase, businessId, "labor", fingerprint);
  if (existingJob) {
    if (existingJob.status === "processing") return err("already_processing_duplicate");
    return { ok: true, duplicate: true, jobId: existingJob.id, summary: existingJob.summary ? { ...(existingJob.summary as LaborImportSummary), duplicate: true } : undefined };
  }

  const seedSummary: LaborImportSummary = { rowsInFile, imported: 0, dateFrom: null, dateTo: null, rejectedRows, pendingWageReview: [] };
  const { dateFrom, dateTo } = dateRange(rows.map((r) => r.clockIn.slice(0, 10)));
  const { data: job, error: jobError } = await supabase
    .from("csv_import_jobs")
    .insert({
      business_id: businessId,
      kind: "labor",
      status: "processing",
      content_fingerprint: fingerprint,
      rows_in_file: rowsInFile,
      group_count: rows.length,
      summary: seedSummary,
      date_from: dateFrom,
      date_to: dateTo,
    })
    .select("id")
    .single();

  if (jobError || !job) {
    if (jobError?.code === "23505" && jobError.message.includes("csv_import_jobs_active_unique")) {
      return err("already_running", undefined, await findActiveJobId(supabase, businessId, "labor"));
    }
    if (jobError?.code === "23505") {
      const retry = await findDuplicateJob(supabase, businessId, "labor", fingerprint);
      if (retry) return { ok: true, duplicate: true, jobId: retry.id, summary: retry.summary as LaborImportSummary };
    }
    return err("create_job_failed");
  }

  // Only now (lock held) do we touch shared employees roster state.
  const employeeNames = [...new Set(rows.map((r) => r.employee))];
  const employeeIdByName = await resolveEmployeeIds(supabase, businessId, employeeNames, employeeChoices);

  // parseLaborCsv's clockIn/clockOut are naive business-local wall-clock strings (no offset) — a
  // bare timestamp written straight into a `timestamptz` column is interpreted as UTC, silently
  // shifting every shift by the business's UTC offset (e.g. 7:48 AM Pacific became 12:48 AM once
  // read back and reformatted in the café's own timezone). Convert through the business's actual
  // timezone first, same as every other POS-sync write path (lib/pos/sync.ts, lib/pos/toast/poll.ts).
  const { data: businessRow } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const timezone = businessRow?.timezone ?? "America/Los_Angeles";

  type StagingRow = {
    job_id: string;
    business_id: string;
    employee_id: string;
    pos_timecard_id: string;
    clock_in: string;
    clock_out: string | null;
    hourly_wage_cents: number | null;
    promoted: boolean;
  };
  // Deduped by (business_id, pos_timecard_id) — the same key the table's unique index and the
  // upsert's onConflict target use — BEFORE batching. A single `INSERT ... ON CONFLICT DO UPDATE`
  // cannot affect the same conflict target twice, so two rows sharing an employee+clock-in within
  // one batch (a duplicated source row, or two overlapping exports) would otherwise fail the whole
  // batch and the whole job, repeatably, on every retry of the unchanged file. The later occurrence
  // wins, consistent with this importer's "latest upload corrects the record" convention elsewhere.
  const stagingByKey = new Map<string, StagingRow>();
  let employeeResolutionFailures = 0;
  let duplicateShiftsInFile = 0;
  for (const row of rows) {
    const employeeId = employeeIdByName.get(row.employee);
    if (!employeeId) {
      employeeResolutionFailures += 1;
      continue;
    }
    const posTimecardId = `csv-${row.employee}-${row.clockIn}`.slice(0, 120);
    const key = `${businessId}:${posTimecardId}`;
    if (stagingByKey.has(key)) duplicateShiftsInFile += 1;
    stagingByKey.set(key, {
      job_id: job.id,
      business_id: businessId,
      employee_id: employeeId,
      pos_timecard_id: posTimecardId,
      clock_in: fromZonedTime(row.clockIn, timezone).toISOString(),
      clock_out: row.clockOut ? fromZonedTime(row.clockOut, timezone).toISOString() : null,
      hourly_wage_cents: row.hourlyWageCents,
      promoted: false,
    });
  }
  const stagingRows = [...stagingByKey.values()];

  // Upsert, not plain insert: the same shift (business_id, pos_timecard_id) may already be staged
  // — unresolved — from an earlier upload of an overlapping date range. Re-staging it under this
  // job (and resetting `promoted` to false) lets the newest upload's clock-out/wage correct it and
  // makes it eligible for this job's finalize, rather than failing on the old unique constraint.
  for (const batch of chunk(stagingRows, GROUP_INSERT_CHUNK_SIZE)) {
    const { error } = await supabase.from("csv_labor_import_rows").upsert(batch, { onConflict: "business_id,pos_timecard_id" });
    if (error) {
      await supabase.from("csv_import_jobs").update({ status: "failed", error_message: error.message, updated_at: new Date().toISOString() }).eq("id", job.id);
      return err("staging_failed");
    }
  }

  const finalRejectedRows: RejectedRowSummary<LaborSummaryRejectReason>[] = [...rejectedRows];
  if (employeeResolutionFailures > 0) finalRejectedRows.push({ reason: "employee_creation_failed", count: employeeResolutionFailures });
  if (duplicateShiftsInFile > 0) finalRejectedRows.push({ reason: "duplicate_shift_in_file", count: duplicateShiftsInFile });
  const summary: LaborImportSummary = { ...seedSummary, rejectedRows: finalRejectedRows };
  await supabase.from("csv_import_jobs").update({ summary, updated_at: new Date().toISOString() }).eq("id", job.id);

  return { ok: true, jobId: job.id, summary };
}

async function pendingWageReviewRows(supabase: SupabaseServerClient, jobId: string, timezone: string) {
  const { data } = await supabase
    .from("csv_labor_import_rows")
    .select("id, clock_in, clock_out, employees(display_name)")
    .eq("job_id", jobId)
    .eq("promoted", false)
    .is("hourly_wage_cents", null);
  return (data ?? []).map((r) => ({
    rowId: r.id as string,
    employee: ((r as { employees?: { display_name?: string } | null }).employees?.display_name as string) ?? "",
    // Formatted server-side in the café's own timezone — the owner reviewing this shift cares what
    // time it was at the café, not what time it was on whatever device/timezone they're using now.
    clockInLabel: formatInTimeZone(new Date(r.clock_in as string), timezone, "EEE MMM d, h:mm a"),
    clockOutLabel: r.clock_out ? formatInTimeZone(new Date(r.clock_out as string), timezone, "EEE MMM d, h:mm a") : null,
  }));
}

/** Promotes every staged labor row with a known wage into canonical `timecards` in one atomic SQL
 * transaction (`csv_finalize_labor_job`). Rows with no wage evidence stay staged and are returned
 * as `pendingWageReview` for the owner to resolve via `resolveLaborImportWage` — never promoted
 * with a fabricated rate. Runs the RPC whenever the job isn't already fully `done` — covering
 * `processing` (first finalize), `needs_wage_review` (re-finalize after a wage is resolved, which
 * previously skipped the RPC entirely and left the corrected row unpromoted) and `failed` (retry) —
 * only a job already `done` short-circuits. */
export async function finalizeLaborImportJob(jobId: string): Promise<{ ok: boolean; imported?: number; summary?: LaborImportSummary } & Partial<ActionError>> {
  const ctx = await context();
  if (!ctx) return err("not_signed_in");
  const { supabase, businessId } = ctx;

  const { data: job } = await supabase.from("csv_import_jobs").select("*").eq("id", jobId).eq("business_id", businessId).single();
  if (!job) return { ok: false, imported: 0, errorCode: "job_not_found" };
  if (job.status === "done") {
    return { ok: true, imported: (job.summary as LaborImportSummary | null)?.imported ?? 0, summary: job.summary as LaborImportSummary };
  }

  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const timezone = business?.timezone ?? "America/Los_Angeles";

  const { error: rpcError } = await supabase.rpc("csv_finalize_labor_job", { p_job_id: jobId });
  if (rpcError) {
    await supabase.from("csv_import_jobs").update({ status: "failed", error_message: rpcError.message, updated_at: new Date().toISOString() }).eq("id", jobId);
    return { ok: false, imported: 0, errorCode: "finalize_failed" };
  }

  const { data: allRows } = await supabase.from("csv_labor_import_rows").select("clock_in, promoted").eq("job_id", jobId);
  const promoted = (allRows ?? []).filter((r) => r.promoted);
  const affectedDates = [...new Set(promoted.map((r) => formatInTimeZone(new Date(r.clock_in as string), timezone, "yyyy-MM-dd")))];
  for (const date of affectedDates) await recomputeDailyRollup(supabase, businessId, date);

  const pending = await pendingWageReviewRows(supabase, jobId, timezone);
  const rejectedRows = (job.summary as LaborImportSummary | null)?.rejectedRows ?? [];
  const summary: LaborImportSummary = { rowsInFile: job.rows_in_file, imported: promoted.length, ...dateRange(affectedDates), rejectedRows, pendingWageReview: pending };

  const hasIssues = pending.length > 0 || rejectedRows.length > 0;
  const finalStatus = hasIssues ? "needs_wage_review" : "done";
  try {
    await upsertUploadHistory(supabase, job, "labor_csv", finalStatus === "needs_wage_review" ? "needs_review" : "done", summary);
  } catch {
    await supabase.from("csv_import_jobs").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", jobId).eq("business_id", businessId);
    return err("finalize_failed");
  }

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/more/uploads/history");
  return { ok: true, imported: promoted.length, summary };
}

/** The owner supplies a wage for one staged shift that had none, then that single row (and any
 * other now-resolvable rows in the same job) is promoted into canonical `timecards`. The raw
 * dollars-and-cents string is parsed and validated here (`toCents`, the same tested parser the CSV
 * importer itself uses) rather than trusting a client-computed cents value, so the UI is never the
 * authority for money math. Never infers the rate from the employee's current default wage
 * automatically — this is always an explicit, reviewed owner action establishing the rate for this
 * specific historical shift. */
export async function resolveLaborImportWage(jobId: string, rowId: string, rawWage: string): Promise<{ ok: boolean; summary?: LaborImportSummary } & Partial<ActionError>> {
  const ctx = await context();
  if (!ctx) return err("not_signed_in");
  const { supabase, businessId } = ctx;
  const hourlyWageCents = toCents(rawWage);
  if (!Number.isInteger(hourlyWageCents) || hourlyWageCents <= 0) return err("wage_invalid");

  const { data: updated, error: updateError } = await supabase
    .from("csv_labor_import_rows")
    .update({ hourly_wage_cents: hourlyWageCents })
    .eq("id", rowId)
    .eq("job_id", jobId)
    .eq("business_id", businessId)
    .eq("promoted", false)
    .select("id")
    .maybeSingle();
  // An ID from an old review must never succeed if its staged shift was moved or deleted.
  if (updateError || !updated) return err("wage_update_failed");

  return finalizeLaborImportJob(jobId);
}

export type IngredientCostImportRow = NormalizedIngredientCostRow & { baseUnitForNew: "g" | "ml" | "each" };

export async function importProcessingFeeRows(
  rows: NormalizedProcessingFeeRow[],
  invalidRows = 0,
): Promise<{ ok: boolean; imported: number; error?: string; summary?: ProcessingFeeImportSummary }> {
  const parsedRows = processingFeeRowsSchema.safeParse(rows);
  if (!parsedRows.success || !Number.isInteger(invalidRows) || invalidRows < 0) return { ok: false, imported: 0, error: "Invalid processing fee rows." };
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;
  const amountByDate = processingFeeTotalsByDate(parsedRows.data);

  for (const [date, amountCents] of amountByDate) {
    await upsertProcessingFeeDailyFact(supabase, {
      businessId,
      businessDate: date,
      amountCents,
      status: "actual",
      sourceType: "manual_actual",
      provider: "manual",
      sourceReference: `processing-fee-report:${date}`,
    });
    await recomputeDailyRollup(supabase, businessId, date);
  }

  const dates = [...amountByDate.keys()];
  const summary: ProcessingFeeImportSummary = {
    rowsInFile: parsedRows.data.length + invalidRows,
    importedDates: dates.length,
    invalidRows,
    ...dateRange(dates),
  };
  await supabase.from("uploads").insert({
    business_id: businessId,
    kind: "processing_fees_csv",
    status: invalidRows > 0 ? "needs_review" : "done",
    summary,
  });
  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  revalidatePath("/more/uploads/history");
  return { ok: true, imported: dates.length, summary };
}

/** Matches each row to an existing ingredient by case-insensitive name; creates a new one (with
 * the owner-chosen base unit from the review step) when there's no match. Always inserts a new
 * `ingredient_prices` row rather than updating in place — that's the price-history table
 * "milk up 70¢" reads from, so today's Menu screen keeps showing yesterday's cost until this
 * row's `effective_from` date. Source is "invoice", the closest fit for a priced inventory
 * report among the fixed source values. */
export async function importIngredientCostRows(rows: IngredientCostImportRow[]): Promise<{ ok: boolean; imported: number; error?: string; summary?: IngredientImportSummary }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: existing } = await supabase.from("ingredients").select("id, name").eq("business_id", businessId);
  const idByLowerName = new Map((existing ?? []).map((i) => [i.name.toLowerCase(), i.id]));

  let imported = 0;
  const newIngredients: string[] = [];
  for (const row of rows) {
    let ingredientId = idByLowerName.get(row.name.toLowerCase());
    if (!ingredientId) {
      const { data: created, error: createError } = await supabase
        .from("ingredients")
        .insert({ business_id: businessId, name: row.name, base_unit: row.baseUnitForNew })
        .select("id")
        .single();
      if (createError || !created) continue;
      ingredientId = created.id;
      idByLowerName.set(row.name.toLowerCase(), ingredientId);
      newIngredients.push(row.name);
    }

    const { error } = await supabase.from("ingredient_prices").insert({
      ingredient_id: ingredientId,
      effective_from: row.effectiveFrom,
      cost_per_base_unit_micros: row.costPerUnitCents * 1_000_000,
      source: "invoice",
    });
    if (!error) imported += 1;
  }

  const summary: IngredientImportSummary = { rowsInFile: rows.length, imported, newIngredients };
  await supabase.from("uploads").insert({ business_id: businessId, kind: "ingredients_csv", status: "done", summary });

  revalidatePath("/menu");
  revalidatePath("/more/uploads/history");
  return { ok: true, imported, summary };
}
