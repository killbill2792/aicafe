"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { recomputeDailyRollup } from "@/lib/pos/rollup";
import { matchCatalogItem } from "@/lib/pos/catalogMatching";
import { hasOpenAlert } from "@/lib/alerts/generate";
import { NEW_EMPLOYEE } from "@/lib/constants";
import { aggregateSalesRows, type AggregatedSalesRow } from "@/lib/pos/csv/aggregateSalesRows";
import type { NormalizedSalesRow, SalesColumnMapping, SalesRejectReason } from "@/lib/pos/csv/parseSalesCsv";
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

export type RejectedRowSummary<R extends string> = { reason: R; count: number };

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
  rejectedRows: RejectedRowSummary<LaborRejectReason>[];
  pendingWageReview: { rowId: string; employee: string; clockIn: string; clockOut: string | null }[];
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

export async function saveMapping(kind: Kind, mapping: AnyMapping, sourceLabel?: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Sign in first." };
  const { error } = await ctx.supabase
    .from("csv_import_mappings")
    .upsert({ business_id: ctx.businessId, kind, column_mapping: mapping, source_label: sourceLabel }, { onConflict: "business_id,kind" });
  return error ? { ok: false, error: error.message } : { ok: true };
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

/** Resolves each distinct item name to a menu_item (lib/pos/catalogMatching.ts, unchanged), run
 * once over the aggregated (deduped) item set rather than once per source row. */
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
    const sample = groups.find((g) => g.item === name)!;
    const priceCents = sample.quantity > 0 ? Math.round(sample.netSalesCents / sample.quantity) : null;
    const posItemId = `csv-item-${csvSlug(name)}`.slice(0, 120);
    const match = matchCatalogItem({ posItemId, name, priceCents, category: null }, candidates);
    if (match.status === "matched" && match.candidateId) {
      menuItemIdByName.set(name.toLowerCase(), match.candidateId);
      await supabase.from("menu_items").update({ pos_item_id: posItemId, catalog_source: "csv", catalog_last_synced_at: new Date().toISOString() }).eq("id", match.candidateId).eq("business_id", businessId);
    } else if (match.status === "new") {
      const { data: created } = await supabase.from("menu_items").insert({ business_id: businessId, pos_item_id: posItemId, name, base_name: name, price_cents: priceCents, category: "ESPRESSO_DRINK", catalog_source: "csv", catalog_last_synced_at: new Date().toISOString() }).select("id").single();
      if (created) menuItemIdByName.set(name.toLowerCase(), created.id);
    } else {
      await supabase.from("pos_catalog_matches").upsert({ business_id: businessId, provider: "csv", pos_item_id: posItemId, imported_name: name, imported_price_cents: priceCents, suggested_menu_item_id: match.candidateId, match_score: match.score, status: "needs_review" }, { onConflict: "business_id,provider,pos_item_id" });
      const rows = groups.filter((g) => g.item === name).reduce((s, g) => s + g.sourceRowCount, 0);
      unmatchedRowsByName.set(name, rows);
    }
  }

  return { menuItemIdByName, unmatchedItems: [...unmatchedRowsByName.entries()].map(([name, rows]) => ({ name, rows })) };
}

/** Starts a sales import job: aggregates rows (lib/pos/csv/aggregateSalesRows.ts — the fix for
 * repeated same-day selections overwriting instead of summing), resolves menu items once over the
 * deduped item set, then stages the bounded group list. Returns a jobId for `finalizeSalesImportJob`
 * to promote atomically — split from this step so neither call does unbounded row-by-row DB work. */
export async function startSalesImportJob(
  rows: NormalizedSalesRow[],
  rowsInFile: number,
  rejectedRows: RejectedRowSummary<SalesRejectReason>[],
): Promise<{ ok: boolean; jobId?: string; duplicate?: boolean; summary?: SalesImportSummary; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  if (rowsInFile > MAX_SOURCE_ROWS) return { ok: false, error: `This file has ${rowsInFile} rows; the limit is ${MAX_SOURCE_ROWS}. Split it into smaller date ranges.` };

  const groups = aggregateSalesRows(rows);
  if (groups.length > MAX_SALES_GROUPS) return { ok: false, error: `This file covers ${groups.length} distinct item/day combinations; the limit is ${MAX_SALES_GROUPS}. Split it into smaller date ranges.` };
  if (groups.length === 0) return { ok: false, error: "No valid sale rows to import." };

  const fingerprint = contentFingerprint("sales", groups);
  const existingJob = await findDuplicateJob(supabase, businessId, "sales", fingerprint);
  if (existingJob) {
    if (existingJob.status === "processing") return { ok: false, error: "This exact file is already being imported. Wait for it to finish." };
    return { ok: true, duplicate: true, jobId: existingJob.id, summary: existingJob.summary ? { ...(existingJob.summary as SalesImportSummary), duplicate: true } : undefined };
  }

  const { data: locationRow } = await supabase.from("locations").select("id").eq("business_id", businessId).limit(1).maybeSingle();
  const { menuItemIdByName, unmatchedItems } = await resolveMenuItemIds(supabase, businessId, groups);

  const { data: job, error: jobError } = await supabase
    .from("csv_import_jobs")
    .insert({
      business_id: businessId,
      kind: "sales",
      status: "processing",
      content_fingerprint: fingerprint,
      rows_in_file: rowsInFile,
      group_count: groups.length,
      ...dateRange(groups.map((g) => g.date)),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    if (jobError?.code === "23505" && jobError.message.includes("csv_import_jobs_active_unique")) {
      return { ok: false, error: "A sales import is already running for this café. Wait for it to finish, or cancel it from Upload history if it's been stuck for several minutes." };
    }
    if (jobError?.code === "23505") {
      const retry = await findDuplicateJob(supabase, businessId, "sales", fingerprint);
      if (retry) return { ok: true, duplicate: true, jobId: retry.id, summary: retry.summary as SalesImportSummary };
    }
    return { ok: false, error: jobError?.message ?? "Could not start the import." };
  }

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
      return { ok: false, error: "Could not stage the import rows. Nothing was imported — try again." };
    }
  }

  return {
    ok: true,
    jobId: job.id,
    summary: { rowsInFile, imported: 0, dateFrom: null, dateTo: null, unmatchedItems, rejectedRows, skippedToastConflictDates: [] },
  };
}

/** Promotes every staged group for a job into canonical orders/order_lines in one atomic SQL
 * transaction (`csv_finalize_sales_job`), then recomputes fees/rollups/alerts for affected dates —
 * the exact same per-date logic the old row-by-row importer used, just run once the atomic write
 * is already done rather than interleaved with it. Safe to call again if a prior call failed
 * partway: the RPC only processes groups not yet marked `promoted`. */
export async function finalizeSalesImportJob(jobId: string): Promise<{ ok: boolean; imported: number; summary?: SalesImportSummary; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: job } = await supabase.from("csv_import_jobs").select("*").eq("id", jobId).eq("business_id", businessId).single();
  if (!job) return { ok: false, imported: 0, error: "Import job not found." };
  if (job.status !== "processing") {
    return { ok: true, imported: job.summary?.imported ?? 0, summary: job.summary as SalesImportSummary };
  }

  const { error: rpcError } = await supabase.rpc("csv_finalize_sales_job", { p_job_id: jobId });
  if (rpcError) {
    await supabase.from("csv_import_jobs").update({ status: "failed", error_message: rpcError.message, updated_at: new Date().toISOString() }).eq("id", jobId);
    return { ok: false, imported: 0, error: "Import failed partway through and was rolled back — no partial data was committed. Try again." };
  }

  const { data: groupRows } = await supabase.from("csv_sales_import_groups").select("business_date, item_name, menu_item_id, source_row_count, conflict_reason").eq("job_id", jobId);
  const groups = groupRows ?? [];
  const promotedGroups = groups.filter((g) => g.conflict_reason !== "toast_covers_date");
  const affectedDates = [...new Set(promotedGroups.map((g) => g.business_date as string))];
  const skippedToastConflictDates = [...new Set(groups.filter((g) => g.conflict_reason === "toast_covers_date").map((g) => g.business_date as string))];

  const unmatchedCounts = new Map<string, number>();
  for (const g of groups) {
    if (!g.menu_item_id && g.conflict_reason !== "toast_covers_date") {
      unmatchedCounts.set(g.item_name as string, (unmatchedCounts.get(g.item_name as string) ?? 0) + (g.source_row_count as number));
    }
  }

  for (const date of affectedDates) {
    const { data: feeOrders, error: feeOrdersError } = await supabase
      .from("orders")
      .select("processing_fee_cents, processing_fee_status")
      .eq("business_id", businessId)
      .eq("business_date", date)
      .eq("processing_fee_provider", "csv");
    if (feeOrdersError) throw feeOrdersError;
    if ((feeOrders ?? []).length > 0 && (feeOrders ?? []).every((order) => order.processing_fee_status === "actual")) {
      await upsertProcessingFeeDailyFact(supabase, {
        businessId,
        businessDate: date,
        amountCents: (feeOrders ?? []).reduce((sum, order) => sum + Number(order.processing_fee_cents), 0),
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
  await supabase.from("csv_import_jobs").update({ status: finalStatus, summary, updated_at: new Date().toISOString() }).eq("id", jobId);
  await supabase.from("uploads").insert({ business_id: businessId, kind: "sales_csv", status: finalStatus, summary });

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

/** Cancels an import job stuck in `processing` for more than 10 minutes — the recovery path when
 * a browser closed or crashed between `startSalesImportJob`/`startLaborImportJob` and the matching
 * finalize call, which would otherwise hold the one-active-job-per-business+kind lock forever. The
 * 10-minute floor (enforced in the UPDATE's WHERE clause, not just in this function) means this can
 * never cancel a different session's genuinely in-flight import. */
export async function cancelStuckImportJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Sign in first." };
  const { supabase, businessId } = ctx;
  const { data, error } = await supabase
    .from("csv_import_jobs")
    .update({ status: "failed", error_message: "Cancelled after being stuck in processing.", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("business_id", businessId)
    .eq("status", "processing")
    .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "This import is still within its normal time window — wait a little longer before cancelling." };
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
 * Returns the resolved id per original (non-lowercased) name. */
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
 * `timecards` until the owner supplies a rate (`resolveLaborImportWage`). */
export async function startLaborImportJob(
  rows: NormalizedLaborRow[],
  employeeChoices: Record<string, string>,
  rowsInFile: number,
  rejectedRows: RejectedRowSummary<LaborRejectReason>[],
): Promise<{ ok: boolean; jobId?: string; duplicate?: boolean; summary?: LaborImportSummary; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  if (rowsInFile > MAX_SOURCE_ROWS) return { ok: false, error: `This file has ${rowsInFile} rows; the limit is ${MAX_SOURCE_ROWS}.` };
  if (rows.length > MAX_LABOR_ROWS) return { ok: false, error: `This file has ${rows.length} valid shifts; the limit is ${MAX_LABOR_ROWS}. Split it into smaller date ranges.` };
  if (rows.length === 0) return { ok: false, error: "No valid shifts to import." };

  const fingerprintPayload = [...rows].sort((a, b) => (a.employee === b.employee ? a.clockIn.localeCompare(b.clockIn) : a.employee.localeCompare(b.employee)));
  const fingerprint = contentFingerprint("labor", fingerprintPayload);
  const existingJob = await findDuplicateJob(supabase, businessId, "labor", fingerprint);
  if (existingJob) {
    if (existingJob.status === "processing") return { ok: false, error: "This exact file is already being imported. Wait for it to finish." };
    return { ok: true, duplicate: true, jobId: existingJob.id, summary: existingJob.summary ? { ...(existingJob.summary as LaborImportSummary), duplicate: true } : undefined };
  }

  const employeeNames = [...new Set(rows.map((r) => r.employee))];
  const employeeIdByName = await resolveEmployeeIds(supabase, businessId, employeeNames, employeeChoices);

  const { data: job, error: jobError } = await supabase
    .from("csv_import_jobs")
    .insert({
      business_id: businessId,
      kind: "labor",
      status: "processing",
      content_fingerprint: fingerprint,
      rows_in_file: rowsInFile,
      group_count: rows.length,
      ...dateRange(rows.map((r) => r.clockIn.slice(0, 10))),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    if (jobError?.code === "23505" && jobError.message.includes("csv_import_jobs_active_unique")) {
      return { ok: false, error: "A labor import is already running for this café. Wait for it to finish, or cancel it from Upload history if it's been stuck for several minutes." };
    }
    if (jobError?.code === "23505") {
      const retry = await findDuplicateJob(supabase, businessId, "labor", fingerprint);
      if (retry) return { ok: true, duplicate: true, jobId: retry.id, summary: retry.summary as LaborImportSummary };
    }
    return { ok: false, error: jobError?.message ?? "Could not start the import." };
  }

  const stagingRows = rows
    .map((row) => {
      const employeeId = employeeIdByName.get(row.employee);
      if (!employeeId) return null;
      return {
        job_id: job.id,
        business_id: businessId,
        employee_id: employeeId,
        pos_timecard_id: `csv-${row.employee}-${row.clockIn}`.slice(0, 120),
        clock_in: row.clockIn,
        clock_out: row.clockOut,
        hourly_wage_cents: row.hourlyWageCents,
        promoted: false,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Upsert, not plain insert: the same shift (business_id, pos_timecard_id) may already be staged
  // — unresolved — from an earlier upload of an overlapping date range. Re-staging it under this
  // job (and resetting `promoted` to false) lets the newest upload's clock-out/wage correct it and
  // makes it eligible for this job's finalize, rather than failing on the old unique constraint.
  for (const batch of chunk(stagingRows, GROUP_INSERT_CHUNK_SIZE)) {
    const { error } = await supabase.from("csv_labor_import_rows").upsert(batch, { onConflict: "business_id,pos_timecard_id" });
    if (error) {
      await supabase.from("csv_import_jobs").update({ status: "failed", error_message: error.message, updated_at: new Date().toISOString() }).eq("id", job.id);
      return { ok: false, error: "Could not stage the import rows. Nothing was imported — try again." };
    }
  }

  return { ok: true, jobId: job.id, summary: { rowsInFile, imported: 0, dateFrom: null, dateTo: null, rejectedRows, pendingWageReview: [] } };
}

async function pendingWageReviewRows(supabase: SupabaseServerClient, jobId: string) {
  const { data } = await supabase
    .from("csv_labor_import_rows")
    .select("id, clock_in, clock_out, employees(display_name)")
    .eq("job_id", jobId)
    .eq("promoted", false)
    .is("hourly_wage_cents", null);
  return (data ?? []).map((r) => ({
    rowId: r.id as string,
    employee: ((r as { employees?: { display_name?: string } | null }).employees?.display_name as string) ?? "",
    clockIn: r.clock_in as string,
    clockOut: r.clock_out as string | null,
  }));
}

/** Promotes every staged labor row with a known wage into canonical `timecards` in one atomic SQL
 * transaction (`csv_finalize_labor_job`). Rows with no wage evidence stay staged and are returned
 * as `pendingWageReview` for the owner to resolve via `resolveLaborImportWage` — never promoted
 * with a fabricated rate. Safe to call again (idempotent on already-promoted rows). */
export async function finalizeLaborImportJob(jobId: string): Promise<{ ok: boolean; imported: number; summary?: LaborImportSummary; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: job } = await supabase.from("csv_import_jobs").select("*").eq("id", jobId).eq("business_id", businessId).single();
  if (!job) return { ok: false, imported: 0, error: "Import job not found." };

  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const timezone = business?.timezone ?? "America/Los_Angeles";

  if (job.status === "processing") {
    const { error: rpcError } = await supabase.rpc("csv_finalize_labor_job", { p_job_id: jobId });
    if (rpcError) {
      await supabase.from("csv_import_jobs").update({ status: "failed", error_message: rpcError.message, updated_at: new Date().toISOString() }).eq("id", jobId);
      return { ok: false, imported: 0, error: "Import failed partway through and was rolled back — no partial data was committed. Try again." };
    }
  }

  const { data: allRows } = await supabase.from("csv_labor_import_rows").select("clock_in, promoted").eq("job_id", jobId);
  const promoted = (allRows ?? []).filter((r) => r.promoted);
  const affectedDates = [...new Set(promoted.map((r) => formatInTimeZone(new Date(r.clock_in as string), timezone, "yyyy-MM-dd")))];
  for (const date of affectedDates) await recomputeDailyRollup(supabase, businessId, date);

  const pending = await pendingWageReviewRows(supabase, jobId);
  const rejectedRows = (job.summary as LaborImportSummary | null)?.rejectedRows ?? [];
  const summary: LaborImportSummary = { rowsInFile: job.rows_in_file, imported: promoted.length, ...dateRange(affectedDates), rejectedRows, pendingWageReview: pending };

  const finalStatus = pending.length > 0 ? "needs_wage_review" : "done";
  await supabase.from("csv_import_jobs").update({ status: finalStatus, summary, updated_at: new Date().toISOString() }).eq("id", jobId);
  if (job.status === "processing") {
    await supabase.from("uploads").insert({ business_id: businessId, kind: "labor_csv", status: finalStatus === "needs_wage_review" ? "needs_review" : "done", summary });
  }

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/more/uploads/history");
  return { ok: true, imported: promoted.length, summary };
}

/** The owner supplies a wage for one staged shift that had none, then that single row (and any
 * other now-resolvable rows in the same job) is promoted into canonical `timecards`. Never infers
 * the rate from the employee's current default wage automatically — this is always an explicit,
 * reviewed owner action establishing the rate for this specific historical shift. */
export async function resolveLaborImportWage(jobId: string, rowId: string, hourlyWageCents: number): Promise<{ ok: boolean; summary?: LaborImportSummary; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, error: "Sign in first." };
  const { supabase, businessId } = ctx;
  if (!Number.isInteger(hourlyWageCents) || hourlyWageCents <= 0) return { ok: false, error: "Enter a wage greater than $0." };

  const { error: updateError } = await supabase
    .from("csv_labor_import_rows")
    .update({ hourly_wage_cents: hourlyWageCents })
    .eq("id", rowId)
    .eq("job_id", jobId)
    .eq("business_id", businessId)
    .eq("promoted", false);
  if (updateError) return { ok: false, error: updateError.message };

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
