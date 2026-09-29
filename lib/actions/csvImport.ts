"use server";

import { revalidatePath } from "next/cache";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { recomputeDailyRollup } from "@/lib/pos/rollup";
import type { NormalizedSalesRow } from "@/lib/pos/csv/parseSalesCsv";
import type { NormalizedLaborRow } from "@/lib/pos/csv/parseLaborCsv";
import type { SalesColumnMapping } from "@/lib/pos/csv/parseSalesCsv";
import type { LaborColumnMapping } from "@/lib/pos/csv/parseLaborCsv";
import type { IngredientCostColumnMapping, NormalizedIngredientCostRow } from "@/lib/pos/csv/parseIngredientCostsCsv";

type Kind = "sales" | "labor" | "ingredients";
type AnyMapping = SalesColumnMapping | LaborColumnMapping | IngredientCostColumnMapping;

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
 * provider column (see PROGRESS.md decisions). Idempotent: re-uploading the same file is a no-op. */
export async function importSalesRows(rows: NormalizedSalesRow[]): Promise<{ ok: boolean; imported: number; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: locationRow } = await supabase.from("locations").select("id").eq("business_id", businessId).limit(1).maybeSingle();
  const { data: menuItems } = await supabase.from("menu_items").select("id, name").eq("business_id", businessId);
  const menuItemIdByName = new Map((menuItems ?? []).map((m) => [m.name.toLowerCase(), m.id]));

  let imported = 0;
  const affectedDates = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const posOrderId = `csv-${row.date}-${row.item}-${i}`.slice(0, 120);
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
          processing_fee_cents: 0,
        },
        { onConflict: "business_id,pos_order_id" },
      )
      .select("id")
      .single();
    if (error || !order) continue;

    await supabase.from("order_lines").delete().eq("order_id", order.id);
    await supabase.from("order_lines").insert({
      order_id: order.id,
      menu_item_id: menuItemIdByName.get(row.item.toLowerCase()) ?? null,
      name: row.item,
      quantity: row.quantity,
      net_sales_cents: row.netSalesCents,
      modifiers: [],
      voided: false,
    });
    affectedDates.add(row.date);
    imported += 1;
  }

  for (const date of affectedDates) await recomputeDailyRollup(supabase, businessId, date);

  revalidatePath("/");
  revalidatePath("/money");
  revalidatePath("/menu");
  return { ok: true, imported };
}

export async function importLaborRows(rows: NormalizedLaborRow[]): Promise<{ ok: boolean; imported: number; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: business } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  const timezone = business?.timezone ?? "America/Los_Angeles";

  const employeeNames = [...new Set(rows.map((r) => r.employee))];
  await supabase.from("employees").upsert(
    employeeNames.map((name) => ({ business_id: businessId, pos_team_member_id: `csv-${name.toLowerCase().replace(/\s+/g, "-")}`, display_name: name })),
    { onConflict: "business_id,pos_team_member_id" },
  );
  const { data: employeeRows } = await supabase.from("employees").select("id, pos_team_member_id").eq("business_id", businessId);
  const employeeIdByPos = new Map((employeeRows ?? []).map((e) => [e.pos_team_member_id, e.id]));

  let imported = 0;
  const affectedDates = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const employeeId = employeeIdByPos.get(`csv-${row.employee.toLowerCase().replace(/\s+/g, "-")}`);
    if (!employeeId) continue;
    const posTimecardId = `csv-${row.employee}-${row.clockIn}-${i}`.slice(0, 120);
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

  revalidatePath("/");
  revalidatePath("/money");
  return { ok: true, imported };
}

export type IngredientCostImportRow = NormalizedIngredientCostRow & { baseUnitForNew: "g" | "ml" | "each" };

/** Matches each row to an existing ingredient by case-insensitive name; creates a new one (with
 * the owner-chosen base unit from the review step) when there's no match. Always inserts a new
 * `ingredient_prices` row rather than updating in place — that's the price-history table
 * "milk up 70¢" reads from, so today's Menu screen keeps showing yesterday's cost until this
 * row's `effective_from` date. Source is "invoice", the closest fit for a priced inventory
 * report among the fixed source values. */
export async function importIngredientCostRows(rows: IngredientCostImportRow[]): Promise<{ ok: boolean; imported: number; error?: string }> {
  const ctx = await context();
  if (!ctx) return { ok: false, imported: 0, error: "Sign in first." };
  const { supabase, businessId } = ctx;

  const { data: existing } = await supabase.from("ingredients").select("id, name").eq("business_id", businessId);
  const idByLowerName = new Map((existing ?? []).map((i) => [i.name.toLowerCase(), i.id]));

  let imported = 0;
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

  revalidatePath("/menu");
  return { ok: true, imported };
}
