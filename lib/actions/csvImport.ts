"use server";

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
import { salesCsvSyntheticOrderId, type NormalizedSalesRow } from "@/lib/pos/csv/parseSalesCsv";
import type { NormalizedLaborRow } from "@/lib/pos/csv/parseLaborCsv";
import type { SalesColumnMapping } from "@/lib/pos/csv/parseSalesCsv";
import type { LaborColumnMapping } from "@/lib/pos/csv/parseLaborCsv";
import type { IngredientCostColumnMapping, NormalizedIngredientCostRow } from "@/lib/pos/csv/parseIngredientCostsCsv";
import { processingFeeTotalsByDate, type NormalizedProcessingFeeRow, type ProcessingFeeColumnMapping } from "@/lib/pos/csv/parseProcessingFeesCsv";
import { setProcessingFeeCandidateEligibility, upsertProcessingFeeDailyFact } from "@/lib/pos/processingFees";

type Kind = "sales" | "labor" | "ingredients" | "processing_fees";
type AnyMapping = SalesColumnMapping | LaborColumnMapping | IngredientCostColumnMapping | ProcessingFeeColumnMapping;
type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export type SalesImportSummary = {
  rowsInFile: number;
  imported: number;
  dateFrom: string | null;
  dateTo: string | null;
  unmatchedItems: { name: string; rows: number }[];
};
export type LaborImportSummary = { rowsInFile: number; imported: number; dateFrom: string | null; dateTo: string | null };
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

/** One synthetic order per item per day (docs/06-integrations.md) — `pos_order_id` is prefixed
 * "csv-" so it's distinguishable from a real register's own order ids; `orders` has no separate
 * provider column (see PROGRESS.md decisions). Idempotent by *content* (date + item), not by the
 * row's position in the file — an owner re-exporting a rolling window (e.g. "last 30 days," every
 * day) will have the same calendar day land at a different row index in each day's file, so a
 * position-based key would silently double-count every day the two uploads overlap on. Keying on
 * date+item alone means the same day's row always upserts in place no matter where in the file it
 * lands or how many overlapping uploads it's been through. */
export async function importSalesRows(rows: NormalizedSalesRow[]): Promise<{ ok: boolean; imported: number; error?: string; summary?: SalesImportSummary }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: locationRow } = await supabase.from("locations").select("id").eq("business_id", businessId).limit(1).maybeSingle();
  const { data: menuItems } = await supabase.from("menu_items").select("id, name, size_label, price_cents, category, pos_item_id").eq("business_id", businessId);
  const candidates = (menuItems ?? []).map((item) => ({ id: item.id, name: item.name, sizeLabel: item.size_label, priceCents: item.price_cents, category: item.category, posItemId: item.pos_item_id }));
  const menuItemIdByName = new Map<string, string>();
  for (const name of [...new Set(rows.map((row) => row.item))]) {
    const sample = rows.find((row) => row.item === name)!;
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
    }
  }

  let imported = 0;
  const affectedDates = new Set<string>();
  const unmatchedCounts = new Map<string, number>();
  for (const row of rows) {
    const posOrderId = salesCsvSyntheticOrderId(row);
    const { data: order, error } = await supabase
      .from("orders")
      .upsert(
        {
          business_id: businessId,
          location_id: locationRow?.id ?? null,
          pos_order_id: posOrderId,
          closed_at: `${row.date}T12:00:00Z`,
          business_date: row.date,
          gross_sales_cents: row.netSalesCents,
          net_sales_cents: row.netSalesCents,
          processing_fee_cents: row.processingFeeCents,
          processing_fee_status: row.processingFeeStatus,
          processing_fee_provider: "csv",
        },
        { onConflict: "business_id,pos_order_id" },
      )
      .select("id")
      .single();
    if (error || !order) continue;

    const menuItemId = menuItemIdByName.get(row.item.toLowerCase()) ?? null;
    if (!menuItemId) unmatchedCounts.set(row.item, (unmatchedCounts.get(row.item) ?? 0) + 1);

    await supabase.from("order_lines").delete().eq("order_id", order.id);
    await supabase.from("order_lines").insert({
      order_id: order.id,
      menu_item_id: menuItemId,
      name: row.item,
      quantity: row.quantity,
      net_sales_cents: row.netSalesCents,
      modifiers: [],
      voided: false,
    });
    affectedDates.add(row.date);
    imported += 1;
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
      // The product-mix CSV candidate is only valid when every attributable fee row for that
      // date is actual. Invalidate this candidate without disturbing a separate manual fee report.
      await setProcessingFeeCandidateEligibility(supabase, {
        businessId,
        businessDate: date,
        sourceType: "manual_actual",
        provider: "csv",
        eligible: false,
      });
    }
    // The sales file explicitly covers this date. Even a legitimate $0-sales export is known
    // zero, not missing. Labor-only recomputes do not pass this override.
    await recomputeDailyRollup(supabase, businessId, date, { salesDataStatus: "actual" });
  }

  const unmatchedItems = [...unmatchedCounts.entries()].map(([name, count]) => ({ name, rows: count }));
  const summary: SalesImportSummary = { rowsInFile: rows.length, imported, ...dateRange([...affectedDates]), unmatchedItems };

  await supabase.from("uploads").insert({
    business_id: businessId,
    kind: "sales_csv",
    status: unmatchedItems.length > 0 ? "needs_review" : "done",
    summary,
  });

  // Sales still count toward the day's total either way (daily_rollups sums order_lines
  // regardless of menu_item_id) — but an unmatched item's quantity/cost is invisible to Menu's
  // per-drink numbers until she adds or renames the item, so this needs her attention even though
  // nothing technically failed. Deduped by the exact set of unmatched names so a re-upload of the
  // same (or an overlapping) file doesn't spam a new alert for a problem she hasn't fixed yet.
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
  return { ok: true, imported, summary };
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

export async function importLaborRows(
  rows: NormalizedLaborRow[],
  employeeChoices: Record<string, string> = {},
): Promise<{ ok: boolean; imported: number; error?: string; summary?: LaborImportSummary }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const timezone = business?.timezone ?? "America/Los_Angeles";

  const employeeNames = [...new Set(rows.map((r) => r.employee))];
  const employeeIdByName = await resolveEmployeeIds(supabase, businessId, employeeNames, employeeChoices);

  let imported = 0;
  const affectedDates = new Set<string>();
  // Keyed on employee + clock-in timestamp alone (both content, not file position) — same
  // idempotency reasoning as importSalesRows above: a shift's actual start time already
  // identifies it uniquely, so a rolling-window re-upload upserts the same shift in place
  // instead of minting a duplicate every time it shifts position in the file.
  for (const row of rows) {
    const employeeId = employeeIdByName.get(row.employee);
    if (!employeeId) continue;
    const posTimecardId = `csv-${row.employee}-${row.clockIn}`.slice(0, 120);
    const { error } = await supabase.from("timecards").upsert(
      {
        business_id: businessId,
        employee_id: employeeId,
        pos_timecard_id: posTimecardId,
        clock_in: row.clockIn,
        clock_out: row.clockOut,
        hourly_wage_cents: row.hourlyWageCents,
        breaks: [],
      },
      { onConflict: "business_id,pos_timecard_id" },
    );
    if (!error) {
      imported += 1;
      affectedDates.add(formatInTimeZone(new Date(row.clockIn), timezone, "yyyy-MM-dd"));
    }
  }

  for (const date of affectedDates) await recomputeDailyRollup(supabase, businessId, date);

  const summary: LaborImportSummary = { rowsInFile: rows.length, imported, ...dateRange([...affectedDates]) };
  await supabase.from("uploads").insert({ business_id: businessId, kind: "labor_csv", status: "done", summary });

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/more/uploads/history");
  return { ok: true, imported, summary };
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
      // cents -> micros: itemIngredientCostCents (lib/calc/ingredients.ts) divides quantity ×
      // micros by 1,000,000 to get cents back, so this must be the inverse of that, not ×10,000
      // (see lib/calc/ingredients.test.ts and scripts/seed/demoData.mjs's ingredientPriceMicros
      // for the same ×1,000,000 convention — this line was off by 100x until now).
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
