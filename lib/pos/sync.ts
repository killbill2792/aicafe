import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PosAdapter, PosTimecard } from "./types";
import { recomputeDailyRollup } from "./rollup";
import { syncCanonicalCatalog } from "./syncCatalog";
import { connectedActualFactFromOrders, setProcessingFeeCandidateEligibility, upsertProcessingFeeDailyFact } from "./processingFees";


function businessDayBounds(date: string, timezone: string): { startIso: string; endIso: string } {
  return {
    startIso: fromZonedTime(`${date}T00:00:00`, timezone).toISOString(),
    endIso: fromZonedTime(`${date}T23:59:59.999`, timezone).toISOString(),
  };
}

/**
 * Keep one canonical attendance row per known shift. If an owner-entered schedule was already
 * materialized, a later POS timecard upgrades that row to actual attendance and retains the
 * schedule as expected_schedule_id. This prevents schedule + POS double-counting while preserving
 * the planned-vs-actual baseline for the Staff screen and Olivia.
 *
 * If a POS row from an older sync already exists alongside a schedule row, the next sync folds the
 * schedule reference into the POS row and removes only the duplicate schedule-generated row.
 */
async function upsertCanonicalPosTimecard(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    employeeId: string;
    timezone: string;
    provider: string;
    timecard: PosTimecard;
  },
): Promise<void> {
  const { businessId, employeeId, timezone, provider, timecard } = params;
  const businessDate = formatInTimeZone(new Date(timecard.clockIn), timezone, "yyyy-MM-dd");
  const { startIso, endIso } = businessDayBounds(businessDate, timezone);

  const [{ data: existingPos, error: existingPosError }, { data: scheduleRows, error: scheduleError }] =
    await Promise.all([
      supabase
        .from("timecards")
        .select("id, expected_schedule_id")
        .eq("business_id", businessId)
        .eq("pos_timecard_id", timecard.posTimecardId)
        .maybeSingle(),
      supabase
        .from("timecards")
        .select("id, schedule_id, expected_schedule_id")
        .eq("business_id", businessId)
        .eq("employee_id", employeeId)
        .not("schedule_id", "is", null)
        .gte("clock_in", startIso)
        .lte("clock_in", endIso)
        .order("clock_in", { ascending: true }),
    ]);
  if (existingPosError) throw existingPosError;
  if (scheduleError) throw scheduleError;

  const scheduleCandidate = (scheduleRows ?? []).find((row) => row.id !== existingPos?.id) ?? null;
  const expectedScheduleId =
    existingPos?.expected_schedule_id ??
    scheduleCandidate?.expected_schedule_id ??
    scheduleCandidate?.schedule_id ??
    null;

  const actualRow = {
    business_id: businessId,
    employee_id: employeeId,
    pos_timecard_id: timecard.posTimecardId,
    schedule_id: null,
    expected_schedule_id: expectedScheduleId,
    source_type: "pos",
    source_provider: provider,
    clock_in: timecard.clockIn,
    clock_out: timecard.clockOut,
    hourly_wage_cents: timecard.hourlyWageCents,
    breaks: timecard.breaks,
  };

  if (existingPos) {
    const { error } = await supabase.from("timecards").update(actualRow).eq("id", existingPos.id);
    if (error) throw error;
    if (scheduleCandidate) {
      const { error: deleteError } = await supabase.from("timecards").delete().eq("id", scheduleCandidate.id);
      if (deleteError) throw deleteError;
    }
    return;
  }

  if (scheduleCandidate) {
    const { error } = await supabase.from("timecards").update(actualRow).eq("id", scheduleCandidate.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from("timecards").insert(actualRow);
  if (error) throw error;
}

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
          processing_fee_status: order.processingFeeStatus,
          processing_fee_provider: adapter.provider,
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

  for (const tc of timecards) {
    const employeeId = employeeIdByPos.get(tc.posTeamMemberId);
    if (!employeeId) continue;
    await upsertCanonicalPosTimecard(supabase, {
      businessId,
      employeeId,
      timezone,
      provider: adapter.provider,
      timecard: tc,
    });
    affectedDates.add(formatInTimeZone(new Date(tc.clockIn), timezone, "yyyy-MM-dd"));
  }

  for (const date of affectedDates) {
    const { data: feeOrders, error: feeOrdersError } = await supabase
      .from("orders")
      .select("processing_fee_cents, processing_fee_status")
      .eq("business_id", businessId)
      .eq("business_date", date)
      .eq("processing_fee_provider", adapter.provider);
    if (feeOrdersError) throw feeOrdersError;
    const connectedFact = connectedActualFactFromOrders((feeOrders ?? []).map((order) => ({
      processingFeeCents: Number(order.processing_fee_cents),
      processingFeeStatus: order.processing_fee_status,
    })), { businessId, businessDate: date, provider: adapter.provider });
    if (connectedFact) {
      await upsertProcessingFeeDailyFact(supabase, connectedFact);
    } else {
      await setProcessingFeeCandidateEligibility(supabase, {
        businessId,
        businessDate: date,
        sourceType: "connected_pos_actual",
        provider: adapter.provider,
        eligible: false,
      });
    }
    await recomputeDailyRollup(supabase, businessId, date);
  }

  return { ordersSynced: orders.length, timecardsSynced: timecards.length, affectedDates: [...affectedDates] };
}
