import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PosAdapter } from "./types";
import { recomputeDailyRollup } from "./rollup";
import { syncCanonicalCatalog } from "./syncCatalog";
import { connectedActualFactFromOrders, setProcessingFeeCandidateEligibility, upsertProcessingFeeDailyFact } from "./processingFees";

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
  const { data: employeeRows } = await supabase.from("employees").select("id, pos_team_member_id, display_name").eq("business_id", businessId);
  const employeeIdByPos = new Map((employeeRows ?? []).map((e) => [e.pos_team_member_id, e.id]));
  const employeeNameById = new Map((employeeRows ?? []).map((e) => [e.id, e.display_name]));

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

  // Reconcile connected actual attendance into an existing owner/AI-Cafe row for the same
  // employee/day instead of creating a second timecard. This keeps one canonical cost row while
  // preserving the schedule itself in staff_schedules for expected-vs-actual comparison.
  for (const tc of timecards) {
    const employeeId = employeeIdByPos.get(tc.posTeamMemberId);
    if (!employeeId) continue;

    const businessDate = formatInTimeZone(new Date(tc.clockIn), timezone, "yyyy-MM-dd");
    affectedDates.add(businessDate);
    const dayStart = fromZonedTime(`${businessDate}T00:00:00`, timezone).toISOString();
    const dayEnd = fromZonedTime(`${businessDate}T23:59:59.999`, timezone).toISOString();

    const { data: samePosRow } = await supabase
      .from("timecards")
      .select("id")
      .eq("business_id", businessId)
      .eq("pos_timecard_id", tc.posTimecardId)
      .maybeSingle();

    if (samePosRow) {
      await supabase.from("timecards").update({
        employee_id: employeeId,
        source_type: "connected_pos",
        source_provider: adapter.provider,
        clock_in: tc.clockIn,
        clock_out: tc.clockOut,
        hourly_wage_cents: tc.hourlyWageCents,
        breaks: tc.breaks,
      }).eq("id", samePosRow.id);
      continue;
    }

    const { data: priorRows } = await supabase
      .from("timecards")
      .select("id, schedule_id, source_type, source_provider, clock_in, clock_out")
      .eq("business_id", businessId)
      .eq("employee_id", employeeId)
      .is("pos_timecard_id", null)
      .gte("clock_in", dayStart)
      .lte("clock_in", dayEnd)
      .order("clock_in", { ascending: true })
      .limit(1);
    const prior = priorRows?.[0] ?? null;

    if (prior) {
      await supabase.from("timecards").update({
        pos_timecard_id: tc.posTimecardId,
        source_type: "connected_pos",
        source_provider: adapter.provider,
        clock_in: tc.clockIn,
        clock_out: tc.clockOut,
        hourly_wage_cents: tc.hourlyWageCents,
        breaks: tc.breaks,
      }).eq("id", prior.id);

      const scheduledStart = new Date(prior.clock_in).getTime();
      const scheduledEnd = prior.clock_out ? new Date(prior.clock_out).getTime() : null;
      const actualStart = new Date(tc.clockIn).getTime();
      const actualEnd = tc.clockOut ? new Date(tc.clockOut).getTime() : null;
      const changed = scheduledStart !== actualStart || scheduledEnd !== actualEnd;

      if (changed) {
        const issue = prior.source_type === "owner_schedule"
          ? "actual clock times differ from the owner schedule"
          : prior.source_type === "ai_cafe"
            ? "POS clock times differ from AI Cafe clock-in/out"
            : "POS clock times differ from previously entered hours";
        await supabase.from("operating_tasks").upsert({
          business_id: businessId,
          id: `staff-actual:${employeeId}:${businessDate}:${tc.posTimecardId}`,
          agent_id: "olivia",
          kind: "staff_coverage",
          entity_type: "employee",
          entity_id: employeeId,
          status: "needs_owner",
          payload: {
            issue,
            employeeName: employeeNameById.get(employeeId) ?? "Staff",
            businessDate,
            previousSource: prior.source_type,
            previousProvider: prior.source_provider,
            expectedClockIn: prior.clock_in,
            expectedClockOut: prior.clock_out,
            actualClockIn: tc.clockIn,
            actualClockOut: tc.clockOut,
            actualProvider: adapter.provider,
          },
          confidence: "high",
          evidence: [{
            source: "staff_actual_reconciliation",
            facts: {
              expectedClockIn: prior.clock_in,
              expectedClockOut: prior.clock_out,
              actualClockIn: tc.clockIn,
              actualClockOut: tc.clockOut,
              actualProvider: adapter.provider,
            },
          }],
        }, { onConflict: "business_id,id" });
      }
      continue;
    }

    // No owner schedule/manual/AI-Cafe row exists for this employee/day, so this POS row becomes
    // the canonical timecard for the day.
    await supabase.from("timecards").insert({
      business_id: businessId,
      employee_id: employeeId,
      pos_timecard_id: tc.posTimecardId,
      source_type: "connected_pos",
      source_provider: adapter.provider,
      clock_in: tc.clockIn,
      clock_out: tc.clockOut,
      hourly_wage_cents: tc.hourlyWageCents,
      breaks: tc.breaks,
    });
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
