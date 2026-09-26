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

type Kind = "sales" | "labor";

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

export async function getSavedMapping(kind: Kind): Promise<SalesColumnMapping | LaborColumnMapping | null> {
  const ctx = await context();
  if (!ctx) return null;
  const { data } = await ctx.supabase.from("csv_import_mappings").select("column_mapping").eq("business_id", ctx.businessId).eq("kind", kind).maybeSingle();
  return (data?.column_mapping as SalesColumnMapping | LaborColumnMapping) ?? null;
}

export async function saveMapping(kind: Kind, mapping: SalesColumnMapping | LaborColumnMapping, sourceLabel?: string): Promise<{ ok: boolean; error?: string }> {
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
