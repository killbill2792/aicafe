import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { subDays } from "date-fns";
import { evaluateRecipeCost, resolveProductCost, monthlyProcessingFeesForWindow, staffCostCentsForPeriod, type DailyFacts, type ProductCostSource, type RecipeCostStatus } from "@/lib/calc";
import type { MenuItemCategoryCode } from "@/lib/constants";
import { trustedOrderCountForProcessingFeeEstimate } from "@/lib/pos/processingFeeEstimate";

/** `productCostCents` is the fractional (unrounded) cost when `recipeStatus === "READY"`, and `0`
 * otherwise (safe for the aggregate sums below — a NO_RECIPE/MISSING_INGREDIENT_COST item should
 * contribute nothing to monthlyVariableProductCostCents, not a fabricated number). `productCostStatus`
 * is the same RecipeCostStatus getMenuItemsForEdit.ts already derives via evaluateRecipeCost — this
 * file now calls that same shared function instead of reimplementing its own cost+completeness
 * check, which previously could disagree with getMenuItemsForEdit's own READY/NO_RECIPE verdict. */
export type PricingItemInput = { id: string; name: string; category: MenuItemCategoryCode; currentPriceCents: number; productCostCents: number; productCostStatus: RecipeCostStatus; productCostSource: ProductCostSource | null; unitsSoldInWindow: number };
export type PricingBusinessInput = { windowDays: number; daysWithSalesInWindow: number; totalOrdersInWindow: number; monthlyRevenueCents: number; monthlyWagesCents?: number; monthlyStaffCostCents: number; monthlyOperatingCostCents: number; monthlyVariableProductCostCents: number; monthlyProcessingFeesCents: number; processingFeesStatus: "actual" | "estimated" | "missing"; productCostsStatus?: "complete" | "missing"; targetOperatingMargin?: number; targetOperatingMarginStatus?: "default" | "confirmed"; payrollTaxRateStatus?: "estimated" | "confirmed"; payrollCostsStatus?: "actual" | "estimated"; operatingCostsStatus?: "actual" | "estimated" };

export async function getPricingInputs(supabase: SupabaseClient, businessId: string): Promise<{ items: PricingItemInput[]; business: PricingBusinessInput }> {
  const { data: businessRow, error: businessError } = await supabase.from("businesses").select("timezone, target_operating_margin, target_operating_margin_status, payroll_tax_rate_status").eq("id", businessId).single();
  if (businessError) throw businessError;
  const timezone = businessRow?.timezone ?? "America/Los_Angeles";
  const today = new Date();
  const todayDateStr = formatInTimeZone(today, timezone, "yyyy-MM-dd");
  const windowDays = 90;
  const fromDateStr = formatInTimeZone(subDays(today, windowDays - 1), timezone, "yyyy-MM-dd");
  const [itemsResult, rollupsResult, recurringResult, ordersResult] = await Promise.all([
    supabase.from("menu_items").select("id, name, price_cents, category").eq("business_id", businessId).eq("is_active", true),
    supabase.from("daily_rollups").select("business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, staff_tax_status, card_fees_cents, card_fees_status, voids_cents").eq("business_id", businessId).gte("business_date", fromDateStr).lte("business_date", todayDateStr),
    supabase.from("recurring_costs").select("amount_cents, category_code, active_from, active_to, is_estimate").eq("business_id", businessId).lte("active_from", todayDateStr),
    supabase.from("orders").select("business_date, pos_order_id, net_sales_cents, processing_fee_provider").eq("business_id", businessId).gte("business_date", fromDateStr).lte("business_date", todayDateStr),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (rollupsResult.error) throw rollupsResult.error;
  if (recurringResult.error) throw recurringResult.error;
  if (ordersResult.error) throw ordersResult.error;
  const rawItems = itemsResult.data ?? [];
  const itemIds = rawItems.map((item) => item.id);
  const [recipesResult, quantitiesResult, fallbackResult] = itemIds.length ? await Promise.all([
    supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", itemIds),
    supabase.rpc("menu_item_quantities_sold", { p_business_id: businessId, p_from: fromDateStr, p_to: todayDateStr }),
    supabase.from("menu_item_cost_fallbacks").select("menu_item_id, cost_cents").eq("business_id", businessId).in("menu_item_id", itemIds),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  if (recipesResult.error) throw recipesResult.error;
  if (quantitiesResult.error) throw quantitiesResult.error;
  if (fallbackResult.error) throw fallbackResult.error;
  const ingredientIds = [...new Set((recipesResult.data ?? []).map((line) => line.ingredient_id))];
  const priceResult = ingredientIds.length ? await supabase.from("ingredient_prices").select("ingredient_id, cost_per_base_unit_micros, effective_from").in("ingredient_id", ingredientIds).lte("effective_from", todayDateStr).order("effective_from", { ascending: true }) : { data: [], error: null };
  if (priceResult.error) throw priceResult.error;
  const prices: Record<string, number> = {};
  for (const row of priceResult.data ?? []) prices[row.ingredient_id] = row.cost_per_base_unit_micros;
  const units = new Map<string, number>((quantitiesResult.data ?? []).map((row: { menu_item_id: string; total_quantity: number | string }) => [row.menu_item_id, Number(row.total_quantity)]));
  const fallbackByItem = new Map<string, number>((fallbackResult.data ?? []).map((row) => [row.menu_item_id, Number(row.cost_cents)]));
  const items = rawItems.map((item) => {
    const lines = (recipesResult.data ?? []).filter((line) => line.menu_item_id === item.id).map((line) => ({ ingredientId: line.ingredient_id, quantity: Number(line.quantity) }));
    const recipeCost = evaluateRecipeCost(lines, prices);
    const cost = resolveProductCost(recipeCost, fallbackByItem.get(item.id) ?? null);
    const category = item.category === "food" ? "FOOD" : item.category === "drink" ? "ESPRESSO_DRINK" : item.category as MenuItemCategoryCode;
    return { id: item.id, name: item.name, category, currentPriceCents: item.price_cents ?? 0, productCostCents: cost.costCents ?? 0, productCostStatus: cost.status, productCostSource: cost.source, unitsSoldInWindow: units.get(item.id) ?? 0 };
  });
  const days: DailyFacts[] = (rollupsResult.data ?? []).map((row) => ({ date: row.business_date, netSalesCents: row.net_sales_cents, ordersCount: row.orders_count, drinksCount: row.drinks_count, ingredientsCents: row.ingredients_cents, wagesCents: row.staff_wages_cents, staffTaxCents: row.staff_tax_cents, cardFeesCents: row.card_fees_cents, voidsCents: row.voids_cents }));
  const scale = 30 / windowDays;
  const monthlyRevenueCents = Math.round(days.reduce((sum, day) => sum + day.netSalesCents, 0) * scale);
  const monthlyWagesCents = Math.round(days.reduce((sum, day) => sum + day.wagesCents, 0) * scale);
  const monthlyStaffCostCents = Math.round(staffCostCentsForPeriod(days) * scale);
  const monthlyProcessingFeesCents = monthlyProcessingFeesForWindow(days.map((day) => day.cardFeesCents), windowDays);
  const payrollCostsStatus =
    (rollupsResult.data ?? []).length > 0 &&
    (rollupsResult.data ?? []).every((row) => row.staff_tax_status === "actual")
      ? "actual" as const
      : "estimated" as const;
  const salesDayFeeStatuses = (rollupsResult.data ?? []).filter((row) => Number(row.net_sales_cents) > 0).map((row) => row.card_fees_status ?? "missing");
  const processingFeesStatus = salesDayFeeStatuses.length === 0 || salesDayFeeStatuses.includes("missing")
    ? "missing"
    : salesDayFeeStatuses.includes("estimated") ? "estimated" : "actual";
  const ordersByDate = new Map<string, { posOrderId: string; netSalesCents: number; processingFeeProvider: string | null }[]>();
  for (const order of ordersResult.data ?? []) {
    const rows = ordersByDate.get(order.business_date) ?? [];
    rows.push({
      posOrderId: order.pos_order_id,
      netSalesCents: Number(order.net_sales_cents),
      processingFeeProvider: order.processing_fee_provider,
    });
    ordersByDate.set(order.business_date, rows);
  }
  const trustedOrdersInWindow = (rollupsResult.data ?? []).reduce((sum, row) => {
    const count = trustedOrderCountForProcessingFeeEstimate(
      ordersByDate.get(row.business_date) ?? [],
      Number(row.net_sales_cents),
    );
    return sum + (count ?? 0);
  }, 0);
  const activeOperatingCosts = (recurringResult.data ?? []).filter(
    (row) => row.category_code !== "ingredients" && (!row.active_to || row.active_to >= todayDateStr),
  );
  const monthlyOperatingCostCents = activeOperatingCosts.reduce((sum, row) => sum + row.amount_cents, 0);
  const operatingCostsStatus = activeOperatingCosts.some((row) => row.is_estimate) ? "estimated" as const : "actual" as const;
  const productCostsStatus = items.some((item) => item.unitsSoldInWindow > 0 && item.productCostStatus !== "READY") ? "missing" as const : "complete" as const;
  const monthlyVariableProductCostCents = Math.round(items.reduce((sum, item) => sum + item.unitsSoldInWindow * item.productCostCents, 0) * scale);
  return { items, business: { windowDays, daysWithSalesInWindow: days.filter((day) => day.netSalesCents > 0).length, totalOrdersInWindow: trustedOrdersInWindow, monthlyRevenueCents, monthlyWagesCents, monthlyStaffCostCents, monthlyOperatingCostCents, monthlyVariableProductCostCents, monthlyProcessingFeesCents, processingFeesStatus, productCostsStatus,
    targetOperatingMargin: Number(businessRow?.target_operating_margin ?? 0.15),
    targetOperatingMarginStatus: businessRow?.target_operating_margin_status ?? "default",
    payrollTaxRateStatus: businessRow?.payroll_tax_rate_status ?? "estimated",
    payrollCostsStatus,
    operatingCostsStatus,
  } };
}
