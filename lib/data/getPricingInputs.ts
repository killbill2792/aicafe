import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { subDays } from "date-fns";
import { evaluateRecipeCost, monthlyProcessingFeesForWindow, staffCostCentsForPeriod, type DailyFacts, type RecipeCostStatus } from "@/lib/calc";
import type { MenuItemCategoryCode } from "@/lib/constants";

/** `productCostCents` is the fractional (unrounded) cost when `recipeStatus === "READY"`, and `0`
 * otherwise (safe for the aggregate sums below — a NO_RECIPE/MISSING_INGREDIENT_COST item should
 * contribute nothing to monthlyVariableProductCostCents, not a fabricated number). `recipeStatus`
 * is the same RecipeCostStatus getMenuItemsForEdit.ts already derives via evaluateRecipeCost — this
 * file now calls that same shared function instead of reimplementing its own cost+completeness
 * check, which previously could disagree with getMenuItemsForEdit's own READY/NO_RECIPE verdict. */
export type PricingItemInput = { id: string; name: string; category: MenuItemCategoryCode; currentPriceCents: number; productCostCents: number; recipeStatus: RecipeCostStatus; unitsSoldInWindow: number };
export type PricingBusinessInput = { windowDays: number; daysWithSalesInWindow: number; totalOrdersInWindow: number; monthlyRevenueCents: number; monthlyStaffCostCents: number; monthlyOperatingCostCents: number; monthlyVariableProductCostCents: number; monthlyProcessingFeesCents: number; processingFeesStatus: "actual" | "estimated" | "missing" };

export async function getPricingInputs(supabase: SupabaseClient, businessId: string): Promise<{ items: PricingItemInput[]; business: PricingBusinessInput }> {
  const { data: businessRow, error: businessError } = await supabase.from("businesses").select("timezone").eq("id", businessId).single();
  if (businessError) throw businessError;
  const timezone = businessRow?.timezone ?? "America/Los_Angeles";
  const today = new Date();
  const todayDateStr = formatInTimeZone(today, timezone, "yyyy-MM-dd");
  const windowDays = 90;
  const fromDateStr = formatInTimeZone(subDays(today, windowDays - 1), timezone, "yyyy-MM-dd");
  const [itemsResult, rollupsResult, recurringResult] = await Promise.all([
    supabase.from("menu_items").select("id, name, price_cents, category").eq("business_id", businessId).eq("is_active", true),
    supabase.from("daily_rollups").select("business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, card_fees_cents, card_fees_status, voids_cents").eq("business_id", businessId).gte("business_date", fromDateStr).lte("business_date", todayDateStr),
    supabase.from("recurring_costs").select("amount_cents, category_code, active_from, active_to").eq("business_id", businessId).lte("active_from", todayDateStr),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (rollupsResult.error) throw rollupsResult.error;
  if (recurringResult.error) throw recurringResult.error;
  const rawItems = itemsResult.data ?? [];
  const itemIds = rawItems.map((item) => item.id);
  const [recipesResult, quantitiesResult] = itemIds.length ? await Promise.all([
    supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", itemIds),
    supabase.rpc("menu_item_quantities_sold", { p_business_id: businessId, p_from: fromDateStr, p_to: todayDateStr }),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (recipesResult.error) throw recipesResult.error;
  if (quantitiesResult.error) throw quantitiesResult.error;
  const ingredientIds = [...new Set((recipesResult.data ?? []).map((line) => line.ingredient_id))];
  const priceResult = ingredientIds.length ? await supabase.from("ingredient_prices").select("ingredient_id, cost_per_base_unit_micros, effective_from").in("ingredient_id", ingredientIds).lte("effective_from", todayDateStr).order("effective_from", { ascending: true }) : { data: [], error: null };
  if (priceResult.error) throw priceResult.error;
  const prices: Record<string, number> = {};
  for (const row of priceResult.data ?? []) prices[row.ingredient_id] = row.cost_per_base_unit_micros;
  const units = new Map<string, number>((quantitiesResult.data ?? []).map((row: { menu_item_id: string; total_quantity: number | string }) => [row.menu_item_id, Number(row.total_quantity)]));
  const items = rawItems.map((item) => {
    const lines = (recipesResult.data ?? []).filter((line) => line.menu_item_id === item.id).map((line) => ({ ingredientId: line.ingredient_id, quantity: Number(line.quantity) }));
    const cost = evaluateRecipeCost(lines, prices);
    const category = item.category === "food" ? "FOOD" : item.category === "drink" ? "ESPRESSO_DRINK" : item.category as MenuItemCategoryCode;
    return { id: item.id, name: item.name, category, currentPriceCents: item.price_cents ?? 0, productCostCents: cost.costCents ?? 0, recipeStatus: cost.status, unitsSoldInWindow: units.get(item.id) ?? 0 };
  });
  const days: DailyFacts[] = (rollupsResult.data ?? []).map((row) => ({ date: row.business_date, netSalesCents: row.net_sales_cents, ordersCount: row.orders_count, drinksCount: row.drinks_count, ingredientsCents: row.ingredients_cents, wagesCents: row.staff_wages_cents, staffTaxCents: row.staff_tax_cents, cardFeesCents: row.card_fees_cents, voidsCents: row.voids_cents }));
  const scale = 30 / windowDays;
  const monthlyRevenueCents = Math.round(days.reduce((sum, day) => sum + day.netSalesCents, 0) * scale);
  const monthlyStaffCostCents = Math.round(staffCostCentsForPeriod(days) * scale);
  const monthlyProcessingFeesCents = monthlyProcessingFeesForWindow(days.map((day) => day.cardFeesCents), windowDays);
  const salesDayFeeStatuses = (rollupsResult.data ?? []).filter((row) => row.orders_count > 0).map((row) => row.card_fees_status ?? "missing");
  const processingFeesStatus = salesDayFeeStatuses.length === 0 || salesDayFeeStatuses.includes("missing")
    ? "missing"
    : salesDayFeeStatuses.includes("estimated") ? "estimated" : "actual";
  const monthlyOperatingCostCents = (recurringResult.data ?? []).filter((row) => row.category_code !== "ingredients" && (!row.active_to || row.active_to >= todayDateStr)).reduce((sum, row) => sum + row.amount_cents, 0);
  const monthlyVariableProductCostCents = Math.round(items.reduce((sum, item) => sum + item.unitsSoldInWindow * item.productCostCents, 0) * scale);
  return { items, business: { windowDays, daysWithSalesInWindow: days.filter((day) => day.ordersCount > 0).length, totalOrdersInWindow: days.reduce((sum, day) => sum + day.ordersCount, 0), monthlyRevenueCents, monthlyStaffCostCents, monthlyOperatingCostCents, monthlyVariableProductCostCents, monthlyProcessingFeesCents, processingFeesStatus } };
}
