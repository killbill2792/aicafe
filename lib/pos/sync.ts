import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PosAdapter } from "./types";
import { recomputeDailyRollup } from "./rollup";
import { syncCanonicalCatalog } from "./syncCatalog";

/**
 * Backfill or incremental sync (docs/06-integrations.md "Sync"): pulls orders/catalog/
 * employees/timecards through the adapter, upserts them idempotently on their pos_* id, then
 * recomputes daily_rollups for every business_date touched.
 */
export async function syncPosData(
  supabase: SupabaseClient,
  params: { businessId: string; locationId: string; timezone: string; adapter: PosAdapter; since: Date; until: Date },
): Promise<{ ordersSynced: number; timecardsSynced: number; affectedDates: string[] }> {
  const { businessId, locationId, timezone, adapter, since, until } = params;
  const affectedDates = new Set<string>();

  await syncCanonicalCatalog(supabase, businessId, adapter);

  const [orders, employees, timecards] = await Promise.all([
    adapter.fetchOrders({ since, until }),
    adapter.fetchEmployees(),
    adapter.fetchTimecards({ since, until }),
  ]);
  const { data: menuRows } = await supabase.from("menu_items").select("id, pos_item_id").eq("business_id", businessId);
  const menuItemIdByPos = new Map((menuRows ?? []).filter((item) => item.pos_item_id).map((item) => [item.pos_item_id, item.id]));

  // Employees first (timecards reference them by pos_team_member_id).
  if (employees.length > 0) {
    await supabase.from("employees").upsert(
      employees.map((e) => ({ business_id: businessId, pos_team_member_id: e.posTeamMemberId, display_name: e.displayName, role: e.role })),
      { onConflict: "business_id,pos_team_member_id" },
    );
  }
  const { data: employeeRows } = await supabase.from("employees").select("id, pos_team_member_id").eq("business_id", businessId);
  const employeeIdByPos = new Map((employeeRows ?? []).map((e) => [e.pos_team_member_id, e.id]));

  for (const order of orders) {
    const businessDate = formatInTimeZone(new Date(order.closedAt), timezone, "yyyy-MM-dd");
    affectedDates.add(businessDate);

    const { data: existing } = await supabase
      .from("orders")
      .upsert(
        {
          business_id: businessId,
          location_id: locationId,
          pos_order_id: order.posOrderId,
          closed_at: order.closedAt,
          business_date: businessDate,
          gross_sales_cents: order.grossSalesCents,
          discounts_cents: order.discountsCents,
          refunds_cents: order.refundsCents,
          tax_cents: order.taxCents,
          tip_cents: order.tipCents,
          processing_fee_cents: order.processingFeeCents,
          net_sales_cents: order.netSalesCents,
        },
        { onConflict: "business_id,pos_order_id" },
      )
      .select("id")
      .single();

    if (!existing) continue;

    await supabase.from("order_lines").delete().eq("order_id", existing.id);
    if (order.lines.length > 0) {
      await supabase.from("order_lines").insert(
        order.lines.map((line) => ({
          order_id: existing.id,
          pos_item_id: line.posItemId,
          menu_item_id: line.posItemId ? menuItemIdByPos.get(line.posItemId) ?? null : null,
          name: line.name,
          quantity: line.quantity,
          net_sales_cents: line.netSalesCents,
          modifiers: line.modifiers,
          voided: line.voided,
          voided_by: line.voidedBy,
        })),
      );
    }
  }

  if (timecards.length > 0) {
    await supabase.from("timecards").upsert(
      timecards
        .filter((tc) => employeeIdByPos.has(tc.posTeamMemberId))
        .map((tc) => ({
          business_id: businessId,
          employee_id: employeeIdByPos.get(tc.posTeamMemberId),
          pos_timecard_id: tc.posTimecardId,
          clock_in: tc.clockIn,
          clock_out: tc.clockOut,
          hourly_wage_cents: tc.hourlyWageCents,
          breaks: tc.breaks,
        })),
      { onConflict: "business_id,pos_timecard_id" },
    );
    for (const tc of timecards) {
      affectedDates.add(formatInTimeZone(new Date(tc.clockIn), timezone, "yyyy-MM-dd"));
    }
  }

  for (const date of affectedDates) {
    await recomputeDailyRollup(supabase, businessId, date);
  }

  return { ordersSynced: orders.length, timecardsSynced: timecards.length, affectedDates: [...affectedDates] };
}
