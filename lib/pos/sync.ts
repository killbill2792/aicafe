import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PosAdapter } from "./types";
import { recomputeDailyRollup } from "./rollup";
import { rebuildSalesFactRollups } from "./salesFactRollups";
import { squareCoveredSalesDates } from "./squareCoveredDates";
import { syncCanonicalCatalog } from "./syncCatalog";
import {syncCanonicalEmployees} from "./syncEmployees";
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
  // Fetch succeeded across the complete Square pagination before any zero-day proof.
  // Only a full café-local day (or the covered portion of the CURRENT day
  // starting at local midnight) can be explicitly marked actual.
  const actualDates=new Set(squareCoveredSalesDates({provider:adapter.provider,
    since,until,timezone}));
  for(const date of actualDates)affectedDates.add(date);
  const { data: menuRows,error: menuReadError } = await supabase.from("menu_items").select("id, pos_item_id").eq("business_id", businessId);
  if(menuReadError)throw menuReadError;
  const menuItemIdByPos = new Map((menuRows ?? []).filter((item) => item.pos_item_id).map((item) => [item.pos_item_id, item.id]));

  // Employees first (timecards reference them by pos_team_member_id).
  await syncCanonicalEmployees(supabase,businessId,adapter,employees);
  const { data: employeeRows,error:staffReadError } = await supabase.from("employees").select("id, pos_team_member_id, display_name").eq("business_id", businessId);
  if(staffReadError)throw staffReadError;
  const employeeIdByPos = new Map((employeeRows ?? []).map((e) => [e.pos_team_member_id, e.id]));
  const employeeNameById = new Map((employeeRows ?? []).map((e) => [e.id, e.display_name]));

  for (const order of orders) {
    const businessDate = formatInTimeZone(new Date(order.closedAt), timezone, "yyyy-MM-dd");
    affectedDates.add(businessDate);

    const { data: existing, error: orderError } = await supabase
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
          employee_id:order.posEmployeeId?employeeIdByPos.get(order.posEmployeeId)??employeeIdByPos.get(`toast:${order.posLocationId}:${order.posEmployeeId}`)??null:null,
          dining_option:order.diningOption??null,
          source_channel:order.sourceChannel??null,
          guest_count:order.guestCount??null,
        },
        { onConflict: "business_id,pos_order_id" },
      )
      .select("id")
      .single();

    if (orderError || !existing) throw orderError ?? new Error("POS order persistence failed");

    const {error:lineDeleteError}=await supabase.from("order_lines").delete().eq("order_id", existing.id);
    if(lineDeleteError)throw lineDeleteError;
    if (order.lines.length > 0) {
      const {error:lineInsertError}=await supabase.from("order_lines").insert(
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
          category:line.category??null,
        })),
      );
      if(lineInsertError)throw lineInsertError;
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

    const { data: samePosRow,error:samePosError } = await supabase
      .from("timecards")
      .select("id,pos_owner_edited")
      .eq("business_id", businessId)
      .eq("pos_timecard_id", tc.posTimecardId)
      .maybeSingle();

    if(samePosError)throw samePosError;
    if (samePosRow) {
      if(samePosRow.pos_owner_edited)continue;
      const {error:timecardUpdateError}=await supabase.from("timecards").update({
        employee_id: employeeId,
        source_type: "connected_pos",
        source_provider: adapter.provider,
        clock_in: tc.clockIn,
        clock_out: tc.clockOut,
        hourly_wage_cents: tc.hourlyWageCents,
        wage_source:"pos",breaks: tc.breaks,
      }).eq("id", samePosRow.id).eq("business_id",businessId);
      if(timecardUpdateError)throw timecardUpdateError;
      continue;
    }

    const { data: priorRows,error:priorRowsError } = await supabase
      .from("timecards")
      .select("id, schedule_id, source_type, source_provider, clock_in, clock_out")
      .eq("business_id", businessId)
      .eq("employee_id", employeeId)
      .is("pos_timecard_id", null)
      .gte("clock_in", dayStart)
      .lte("clock_in", dayEnd)
      .order("clock_in", { ascending: true })
      .limit(1);
    if(priorRowsError)throw priorRowsError;
    const prior = priorRows?.[0] ?? null;

    if(prior){
      // A POS clock must not replace an owner/imported/scheduled shift. Ask once.
      const {error:reviewError}=await supabase.from("pos_import_reviews").upsert({
        business_id:businessId,provider:adapter.provider,
        review_type:"overlapping_timecard",source_key:tc.posTimecardId,
        detail:{employeeId,existingTimecardId:prior.id,actualClockIn:tc.clockIn,
          actualClockOut:tc.clockOut}
      },{onConflict:"business_id,provider,review_type,source_key"});
      if(reviewError)throw reviewError;
      continue;
    }

    // No owner schedule/manual/AI-Cafe row exists for this employee/day, so this POS row becomes
    // the canonical timecard for the day.
    const {error:timecardInsertError}=await supabase.from("timecards").insert({
      business_id: businessId,
      employee_id: employeeId,
      pos_timecard_id: tc.posTimecardId,
      source_type: "connected_pos",
      source_provider: adapter.provider,
      clock_in: tc.clockIn,
      clock_out: tc.clockOut,
      hourly_wage_cents: tc.hourlyWageCents,
      wage_source:"pos",breaks: tc.breaks,
    });
    if(timecardInsertError)throw timecardInsertError;
  }

  for (const date of affectedDates) {
    const { data: feeOrders, error: feeOrdersError } = await supabase
      .from("orders")
      .select("processing_fee_cents, processing_fee_status")
      .eq("business_id", businessId)
      .eq("business_date", date)
      .eq("toast_excluded", false).is("superseded_by", null)
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
    await recomputeDailyRollup(supabase,businessId,date,
      actualDates.has(date)?{salesDataStatus:"actual"}:{});
  }

  await rebuildSalesFactRollups(supabase,businessId,[...affectedDates],timezone);
  return { ordersSynced: orders.length, timecardsSynced: timecards.length, affectedDates: [...affectedDates] };
}
