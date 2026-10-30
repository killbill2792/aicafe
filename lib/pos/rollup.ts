import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromZonedTime } from "date-fns-tz";
import {readAllPosRows,posIdBatches} from "./pagedReads";
import { itemIngredientCostCents } from "@/lib/calc";
import { timecardWagesForLocalDay } from "./timecardDay";
import {laborWageStatusFromTimecards} from "@/lib/calc/profit";
import { processingFeeForRollup } from "./processingFees";
import { ensureOwnerConfirmedProcessingFeeEstimateForDay } from "./processingFeeEstimate.server";
import {refreshToastPaymentFeeForDay} from "./toast/paymentFeeFacts.server";
import {hasIncompleteToastLabor, type StagedToastShift} from "./toast/laborCoverage";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import { resolveSalesDataStatus, type SalesDataStatus } from "./salesCoverage";

/**
 * Recomputes daily_rollups for one business_date from the raw orders/order_lines/timecards
 * already in the DB (docs/06-integrations.md: "After each sync, recompute daily_rollups for
 * affected business dates, then alerts"). Ingredients are theoretical, priced as of `businessDate`.
 */
export async function recomputeDailyRollup(
  supabase: SupabaseClient,
  businessId: string,
  businessDate: string,
  options: { salesDataStatus?: SalesDataStatus; dryRun?: boolean } = {},
): Promise<void | Record<string, unknown>> {
  const { data: business, error: businessError } = await supabase.from("businesses").select("payroll_tax_rate, payroll_tax_rate_source, timezone").eq("id", businessId).single();
  // This RLS-protected read is the authorization boundary for the caller-supplied
  // café ID, before any service-only Toast staging evidence can be accessed.
  if (businessError || !business) throw new Error("Rollup business scope unavailable");
  const payrollTaxRate = Number(business?.payroll_tax_rate ?? 0.12);
  const payrollTaxRateSource = business?.payroll_tax_rate_source ?? "system_estimate";
  const timezone = business?.timezone ?? "America/Los_Angeles";

  const orders = await readAllPosRows((first,last)=>supabase
    .from("orders")
    .select("id, net_sales_cents, pos_order_id, processing_fee_provider, toast_excluded, superseded_by")
    .eq("business_id", businessId)
    .eq("business_date", businessDate)
    .order("id").range(first,last),"daily orders");

  const effectiveOrders = orders.filter(o => !o.toast_excluded && !o.superseded_by);
  const orderIds = effectiveOrders.map((o) => o.id);
  const netSalesCents = effectiveOrders.reduce((s, o) => s + o.net_sales_cents, 0);
  const ordersCount = orderIds.length;

  // Keep the owner-confirmed fallback current before selecting the canonical fee fact. Synthetic
  // product/day CSV rows are never treated as transactions; the estimator will use a real
  // provider-attributed order count only when it fully reconciles to the day's sales, otherwise
  // it requires the owner's explicit average processed-ticket assumption.
  if (!options.dryRun) await ensureOwnerConfirmedProcessingFeeEstimateForDay(supabase, {
    businessId,
    businessDate,
    netSalesCents,
    orders: effectiveOrders.map((order) => ({
      posOrderId: order.pos_order_id,
      netSalesCents: Number(order.net_sales_cents),
      processingFeeProvider: order.processing_fee_provider,
    })),
  });

  // Follow-up D: retain Toast's per-payment actual fees, or a checked owner
  // estimate, before selecting the shared daily fee fact. Non-Toast POS unaffected.
  if (!options.dryRun && effectiveOrders.some(o => o.pos_order_id.startsWith("toast:")))
    await refreshToastPaymentFeeForDay(supabase,businessId,businessDate);

  const { data: processingFeeFact, error: processingFeeError } = await supabase
    .from("processing_fee_daily_facts")
    .select("amount_cents, status")
    .eq("business_id", businessId)
    .eq("business_date", businessDate)
    .maybeSingle();
  if (processingFeeError) throw processingFeeError;
  const selectedProcessingFee = processingFeeForRollup(processingFeeFact ? {
    amountCents: Number(processingFeeFact.amount_cents),
    status: processingFeeFact.status,
  } : null);

  const lines: Array<{id:string;order_id:string;menu_item_id:string|null;
    quantity:number;net_sales_cents:number;voided:boolean}> = [];
  for (const batch of posIdBatches(orderIds)) {
    lines.push(...await readAllPosRows((first,last)=>supabase.from("order_lines")
      .select("id, order_id, menu_item_id, quantity, net_sales_cents, voided")
      .in("order_id",batch).order("id").range(first,last),"daily order lines"));
  }

  const nonVoidedLines = lines.filter((l) => !l.voided);
  const voidedLines = lines.filter((l) => l.voided);
  const drinksCount = nonVoidedLines.reduce((s, l) => s + Number(l.quantity), 0);
  // Only Toast reconciliation can certify complete void amounts. Ordinary rollups
  // must not replace a previously certified void total with voided-line net=0.
  const voidsCents = voidedLines.reduce((s, l) => s + l.net_sales_cents, 0);

  // Theoretical ingredient cost: recipe cost per menu item × quantity sold, at this date's prices.
  const menuItemIds = [...new Set(nonVoidedLines.map((l) => l.menu_item_id).filter((id): id is string => id !== null))];
  let ingredientsCents = 0;
  if (menuItemIds.length > 0) {
    const recipeLines:Array<{menu_item_id:string;ingredient_id:string;quantity:number}>=[];
    for(const batch of posIdBatches(menuItemIds)){
      recipeLines.push(...await readAllPosRows((first,last)=>supabase.from("recipe_lines")
        .select("menu_item_id, ingredient_id, quantity").in("menu_item_id",batch)
        .order("menu_item_id").order("ingredient_id").range(first,last),"recipe lines"));
    }
    const ingredientIds = [...new Set(recipeLines.map((r) => r.ingredient_id))];
    const priceRows:Array<{ingredient_id:string;effective_from:string;
      cost_per_base_unit_micros:number}>=[];
    for(const batch of posIdBatches(ingredientIds)){
      priceRows.push(...await readAllPosRows((first,last)=>supabase.from("ingredient_prices")
        .select("ingredient_id, effective_from, cost_per_base_unit_micros")
        .in("ingredient_id",batch).lte("effective_from",businessDate)
        .order("effective_from",{ascending:true}).order("recorded_at",{ascending:true})
        .order("id",{ascending:true}).range(first,last),"ingredient prices"));
    }
    const priceMicros: Record<string, number> = {};
    for (const row of priceRows ?? []) priceMicros[row.ingredient_id] = row.cost_per_base_unit_micros;

    const recipeByItem = new Map<string, { ingredientId: string; quantity: number }[]>();
    for (const r of recipeLines ?? []) {
      const arr = recipeByItem.get(r.menu_item_id) ?? [];
      arr.push({ ingredientId: r.ingredient_id, quantity: Number(r.quantity) });
      recipeByItem.set(r.menu_item_id, arr);
    }

    for (const line of nonVoidedLines) {
      const recipe = line.menu_item_id ? recipeByItem.get(line.menu_item_id) : undefined;
      if (recipe) ingredientsCents += itemIngredientCostCents(recipe, priceMicros) * Number(line.quantity);
    }
  }

  // Business-local calendar day, converted to UTC bounds — NOT a raw `${businessDate}T00:00:00Z`
  // string, which silently misses any shift whose clock-in is in the evening in a timezone behind
  // UTC (its UTC instant already rolls into the next UTC calendar date). Same bug class this
  // codebase has hit before (see runningCosts.ts's decision note) — found here live, the first
  // time an evening shift actually existed to expose it.
  const dayStartUtc = fromZonedTime(`${businessDate}T00:00:00`, timezone).toISOString();
  const nextDay = new Date(Date.parse(businessDate+"T12:00:00Z")+86400000).toISOString().slice(0,10);
  const dayEndUtc = fromZonedTime(`${nextDay}T00:00:00`, timezone).toISOString();
  // Include any timecard that overlaps this café-local day, not only shifts
  // which started today. End is exclusive, including at DST boundaries.
  const timecards=await readAllPosRows((first,last)=>supabase
    .from("timecards")
    .select("id, pos_timecard_id, clock_in, clock_out, hourly_wage_cents, wage_source, breaks, source_type, provider_regular_hours, provider_overtime_hours")
    .eq("business_id", businessId)
    .lt("clock_in", dayEndUtc)
    .or("clock_out.is.null,clock_out.gt."+dayStartUtc)
    .order("id").range(first,last),"daily timecards");


  // Only certified, closed Toast shifts can establish $0 pay. A staged shift
  // without a matching canonical timecard is a PARTIAL day, even if five of
  // six other workers were imported and their wages look complete.
  const paidTimecards=timecards.filter(tc=>tc.source_type!=="owner_schedule");
  const toastSales=netSalesCents>0&&effectiveOrders.some(o=>o.pos_order_id?.startsWith("toast:"));
  const toastAttendance=paidTimecards.some(tc=>tc.pos_timecard_id?.startsWith("toast:"));
  let stagedGap=false;
  if(toastSales||toastAttendance){
    // Toast staging is service-role-only by migration 045. The original caller
    // may be an authenticated owner finalizing a CSV import, not a cron job.
    // After checking that caller can read this business above, read only this
    // business's narrowly bounded staging evidence with the server-only client.
    // No raw provider row leaves this canonical rollup writer.
    const laborDb=process.env.SUPABASE_SERVICE_ROLE_KEY
      ?createAdminSupabaseClient():supabase;
    const staged=await readAllPosRows((first,last)=>laborDb.from("toast_labor_entries")
      .select("restaurant_guid,external_time_entry_id,clock_in,clock_out,hourly_wage_cents,provider_regular_hours,provider_overtime_hours,deleted")
      .eq("business_id",businessId).eq("deleted",false)
      .lt("clock_in",dayEndUtc)
      .or("clock_out.is.null,clock_out.gt."+dayStartUtc)
      .order("restaurant_guid").order("external_time_entry_id").range(first,last),
      "staged Toast labor");
    stagedGap=hasIncompleteToastLabor(staged as StagedToastShift[],paidTimecards);
  }
  const incomplete=stagedGap||
    paidTimecards.some(tc=>tc.hourly_wage_cents===null)||
    (toastSales&&!toastAttendance);
  // A known-only subtotal must not be exported as the whole day's wages or
  // used as the base for an estimated employer payroll tax.
  const wagesCents=incomplete||(paidTimecards.length===0&&toastSales)?null:
    paidTimecards.reduce((sum,tc)=>{
      const amount=timecardWagesForLocalDay({
        clockIn:tc.clock_in,clockOut:tc.clock_out,
        hourlyWageCents:tc.hourly_wage_cents,breaks:tc.breaks??[],
        providerRegularHours:tc.provider_regular_hours==null?null:Number(tc.provider_regular_hours),
        providerOvertimeHours:tc.provider_overtime_hours==null?null:Number(tc.provider_overtime_hours),
      },businessDate,timezone);
      return sum+(amount??0);
    },0);
  const laborWageStatus=incomplete?"missing":laborWageStatusFromTimecards(paidTimecards);
  const { data: existingRollup, error: existingRollupError } = await supabase
    .from("daily_rollups")
    .select("staff_tax_cents, staff_tax_status, staff_tax_source, sales_data_status, voids_status, voids_cents")
    .eq("business_id", businessId)
    .eq("business_date", businessDate)
    .maybeSingle();
  if (existingRollupError) throw existingRollupError;

  // A connected/imported actual payroll burden outranks the business-level rate estimate.
  // Recomputing sales/labor must never replace that actual amount with wages × assumption.
  const staffTaxIsActual = existingRollup?.staff_tax_status === "actual";
  const staffTaxCents = staffTaxIsActual
    ? existingRollup?.staff_tax_cents==null?null:Number(existingRollup.staff_tax_cents)
    : wagesCents===null?null:Math.round(wagesCents * payrollTaxRate);
  const staffTaxSource = staffTaxIsActual
    ? existingRollup?.staff_tax_source ?? "legacy_actual"
    : payrollTaxRateSource;
  const salesDataStatus = resolveSalesDataStatus({
    explicitStatus: options.salesDataStatus,
    previousStatus: existingRollup?.sales_data_status,
    ordersCount,
    netSalesCents,
    drinksCount,
  });

  const proposed = {
      business_id: businessId,
      business_date: businessDate,
      net_sales_cents: netSalesCents,
      orders_count: ordersCount,
      drinks_count: drinksCount,
      ingredients_cents: Math.round(ingredientsCents),
      staff_wages_cents: wagesCents===null?null:Math.round(wagesCents),
      labor_wage_status:laborWageStatus,
      staff_tax_cents: staffTaxCents,
      staff_tax_status: staffTaxIsActual ? "actual" : "estimated",
      staff_tax_source: staffTaxSource,
      sales_data_status: salesDataStatus,
      card_fees_cents: selectedProcessingFee.amountCents,
      card_fees_status: selectedProcessingFee.status,
      voids_cents: existingRollup?.voids_status === "complete" ? existingRollup.voids_cents : voidsCents,
    };
  // Read-only preview uses the same sales, recipe and payroll calculations.
  // Never insert or update a fact (including fee estimates) in dry-run mode.
  if (options.dryRun) return proposed;
  const {error:writeError}=await supabase.from("daily_rollups").upsert(proposed,
    { onConflict: "business_id,business_date" },
  );
  if(writeError)throw writeError;
}
