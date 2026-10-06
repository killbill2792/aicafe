import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromZonedTime } from "date-fns-tz";
import { itemIngredientCostCents, wagesCentsForTimecard } from "@/lib/calc";
import { processingFeeForRollup } from "./processingFees";
import { ensureOwnerConfirmedProcessingFeeEstimateForDay } from "./processingFeeEstimate.server";
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
  options: { salesDataStatus?: SalesDataStatus } = {},
): Promise<void> {
  const { data: business } = await supabase.from("businesses").select("payroll_tax_rate, payroll_tax_rate_source, timezone").eq("id", businessId).single();
  const payrollTaxRate = Number(business?.payroll_tax_rate ?? 0.12);
  const payrollTaxRateSource = business?.payroll_tax_rate_source ?? "system_estimate";
  const timezone = business?.timezone ?? "America/Los_Angeles";

  const { data: orders } = await supabase
    .from("orders")
    .select("id, net_sales_cents, pos_order_id, processing_fee_provider")
    .eq("business_id", businessId)
    .eq("business_date", businessDate);

  const orderIds = (orders ?? []).map((o) => o.id);
  const netSalesCents = (orders ?? []).reduce((s, o) => s + o.net_sales_cents, 0);
  const ordersCount = orderIds.length;

  // Keep the owner-confirmed fallback current before selecting the canonical fee fact. Synthetic
  // product/day CSV rows are never treated as transactions; the estimator will use a real
  // provider-attributed order count only when it fully reconciles to the day's sales, otherwise
  // it requires the owner's explicit average processed-ticket assumption.
  await ensureOwnerConfirmedProcessingFeeEstimateForDay(supabase, {
    businessId,
    businessDate,
    netSalesCents,
    orders: (orders ?? []).map((order) => ({
      posOrderId: order.pos_order_id,
      netSalesCents: Number(order.net_sales_cents),
      processingFeeProvider: order.processing_fee_provider,
    })),
  });

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

  const { data: lines } = orderIds.length
    ? await supabase
        .from("order_lines")
        .select("id, order_id, menu_item_id, quantity, net_sales_cents, voided")
        .in("order_id", orderIds)
    : { data: [] };

  const nonVoidedLines = (lines ?? []).filter((l) => !l.voided);
  const voidedLines = (lines ?? []).filter((l) => l.voided);
  const drinksCount = nonVoidedLines.reduce((s, l) => s + Number(l.quantity), 0);
  const voidsCents = voidedLines.reduce((s, l) => s + l.net_sales_cents, 0);

  // Theoretical ingredient cost: recipe cost per menu item × quantity sold, at this date's prices.
  const menuItemIds = [...new Set(nonVoidedLines.map((l) => l.menu_item_id).filter(Boolean))];
  let ingredientsCents = 0;
  if (menuItemIds.length > 0) {
    const { data: recipeLines } = await supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", menuItemIds);
    const ingredientIds = [...new Set((recipeLines ?? []).map((r) => r.ingredient_id))];
    const { data: priceRows } = ingredientIds.length
      ? await supabase
          .from("ingredient_prices")
          .select("ingredient_id, effective_from, cost_per_base_unit_micros")
          .in("ingredient_id", ingredientIds)
          .lte("effective_from", businessDate)
          .order("effective_from", { ascending: true })
      : { data: [] };
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
  const dayEndUtc = fromZonedTime(`${businessDate}T23:59:59.999`, timezone).toISOString();
  const { data: timecards } = await supabase
    .from("timecards")
    .select("clock_in, clock_out, hourly_wage_cents, breaks")
    .eq("business_id", businessId)
    .gte("clock_in", dayStartUtc)
    .lte("clock_in", dayEndUtc);

  const wagesCents = (timecards ?? []).reduce(
    (sum, tc) =>
      sum +
      wagesCentsForTimecard({
        clockIn: tc.clock_in,
        clockOut: tc.clock_out,
        hourlyWageCents: tc.hourly_wage_cents,
        breaks: tc.breaks ?? [],
      }),
    0,
  );
  const { data: existingRollup, error: existingRollupError } = await supabase
    .from("daily_rollups")
    .select("staff_tax_cents, staff_tax_status, staff_tax_source, sales_data_status")
    .eq("business_id", businessId)
    .eq("business_date", businessDate)
    .maybeSingle();
  if (existingRollupError) throw existingRollupError;

  // A connected/imported actual payroll burden outranks the business-level rate estimate.
  // Recomputing sales/labor must never replace that actual amount with wages × assumption.
  const staffTaxIsActual = existingRollup?.staff_tax_status === "actual";
  const staffTaxCents = staffTaxIsActual
    ? Number(existingRollup.staff_tax_cents)
    : Math.round(wagesCents * payrollTaxRate);
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

  await supabase.from("daily_rollups").upsert(
    {
      business_id: businessId,
      business_date: businessDate,
      net_sales_cents: netSalesCents,
      orders_count: ordersCount,
      drinks_count: drinksCount,
      ingredients_cents: Math.round(ingredientsCents),
      staff_wages_cents: Math.round(wagesCents),
      staff_tax_cents: staffTaxCents,
      staff_tax_status: staffTaxIsActual ? "actual" : "estimated",
      staff_tax_source: staffTaxSource,
      sales_data_status: salesDataStatus,
      card_fees_cents: selectedProcessingFee.amountCents,
      card_fees_status: selectedProcessingFee.status,
      voids_cents: voidsCents,
    },
    { onConflict: "business_id,business_date" },
  );
}
