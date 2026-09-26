import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { itemIngredientCostCents, type DailyFacts, type ExpenseCategoryCode } from "@/lib/calc";
import { generateAlerts } from "@/lib/alerts/generate";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessSnapshot, MenuItemSnapshot, RunningCostLine } from "./types";

const RUNNING_COST_CODES: ExpenseCategoryCode[] = [
  "rent",
  "utilities_power",
  "water",
  "internet",
  "insurance",
  "loan",
  "software",
  "supplies",
  "repairs",
  "other",
];

const RUNNING_COST_LABELS: Record<string, string> = {
  rent: "Rent",
  utilities_power: "Electricity & gas",
  water: "Water",
  internet: "Internet & phone",
  insurance: "Insurance",
  loan: "Loan payment",
  software: "Software",
  supplies: "Store runs & supplies",
  repairs: "Repairs",
  other: "Other",
};

function rowToDailyFacts(row: {
  business_date: string;
  net_sales_cents: number;
  orders_count: number;
  drinks_count: number;
  ingredients_cents: number;
  staff_wages_cents: number;
  staff_tax_cents: number;
  card_fees_cents: number;
  voids_cents: number;
}): DailyFacts {
  return {
    date: row.business_date,
    netSalesCents: row.net_sales_cents,
    ordersCount: row.orders_count,
    drinksCount: row.drinks_count,
    ingredientsCents: row.ingredients_cents,
    wagesCents: row.staff_wages_cents,
    staffTaxCents: row.staff_tax_cents,
    cardFeesCents: row.card_fees_cents,
    voidsCents: row.voids_cents,
  };
}

/** Real Supabase-backed snapshot. Untested against a live project (see PROGRESS.md "Needs connecting"). */
export async function getBusinessSnapshotFromDb(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessSnapshot> {
  const { data: businessRow, error: businessError } = await supabase
    .from("businesses")
    .select("id, name, timezone, payroll_tax_rate")
    .eq("id", businessId)
    .single();
  if (businessError || !businessRow) throw new Error(`Business not found: ${businessId}`);

  const timezone = businessRow.timezone;
  const todayDateStr = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const monthKey = todayDateStr.slice(0, 7);
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = `${monthKey}-01`;
  const prevMonthDate = new Date(year, month - 2, 1);
  const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const prevMonthStart = `${prevMonthKey}-01`;
  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  const prevMonthEnd = `${prevMonthKey}-${String(prevMonthDays).padStart(2, "0")}`;

  const { data: rollupRows, error: rollupError } = await supabase
    .from("daily_rollups")
    .select(
      "business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, card_fees_cents, voids_cents",
    )
    .eq("business_id", businessId)
    .gte("business_date", prevMonthStart)
    .lte("business_date", todayDateStr)
    .order("business_date", { ascending: true });
  if (rollupError) throw rollupError;

  const allDays = (rollupRows ?? []).map(rowToDailyFacts);
  const monthActualDays = allDays.filter((d) => d.date >= monthStart && d.date <= todayDateStr);
  const previousMonthDays = allDays.filter((d) => d.date >= prevMonthStart && d.date <= prevMonthEnd);
  const last28Days = allDays.slice(-28);
  const last7Days = allDays.slice(-7);
  const latestDay = allDays[allDays.length - 1] ?? {
    date: todayDateStr,
    netSalesCents: 0,
    ordersCount: 0,
    drinksCount: 0,
    ingredientsCents: 0,
    wagesCents: 0,
    staffTaxCents: 0,
    cardFeesCents: 0,
    voidsCents: 0,
  };

  const [recurringResult, expensesResult, recoveryOrderResult] = await Promise.all([
    supabase
      .from("recurring_costs")
      .select("category_code, amount_cents, is_estimate, active_from, active_to")
      .eq("business_id", businessId),
    supabase
      .from("expenses")
      .select("category_code, amount_cents, status")
      .eq("business_id", businessId)
      .gte("spent_on", monthStart)
      .lte("spent_on", todayDateStr),
    supabase
      .from("recovery_order")
      .select("bucket_code, position")
      .eq("business_id", businessId)
      .order("position", { ascending: true }),
  ]);
  if (recurringResult.error) throw recurringResult.error;
  if (expensesResult.error) throw expensesResult.error;
  if (recoveryOrderResult.error) throw recoveryOrderResult.error;

  const recoveryOrder = (recoveryOrderResult.data ?? []).map((r) => r.bucket_code);
  const orderedCodes = recoveryOrder.length > 0 ? recoveryOrder : RUNNING_COST_CODES;

  const runningCostLines: RunningCostLine[] = orderedCodes
    .filter((code): code is ExpenseCategoryCode => RUNNING_COST_CODES.includes(code as ExpenseCategoryCode))
    .map((code) => {
      const recurring = (recurringResult.data ?? []).find(
        (r) => r.category_code === code && r.active_from <= todayDateStr && (!r.active_to || r.active_to >= todayDateStr),
      );
      const expensesThisMonth = (expensesResult.data ?? []).filter((e) => e.category_code === code);

      if (expensesThisMonth.length > 0) {
        return {
          categoryCode: code,
          label: RUNNING_COST_LABELS[code] ?? code,
          amountCents: expensesThisMonth.reduce((sum, e) => sum + e.amount_cents, 0),
          isEstimate: expensesThisMonth.some((e) => e.status === "estimated"),
          isMissing: false,
        };
      }
      if (recurring) {
        return {
          categoryCode: code,
          label: RUNNING_COST_LABELS[code] ?? code,
          amountCents: recurring.amount_cents,
          isEstimate: recurring.is_estimate,
          isMissing: false,
        };
      }
      return { categoryCode: code, label: RUNNING_COST_LABELS[code] ?? code, amountCents: 0, isEstimate: false, isMissing: true };
    });

  const menuItems = await getMenuItemSnapshots(supabase, businessId, todayDateStr, last28Days.map((d) => d.date));

  // Regenerate alerts opportunistically (no cron yet — see PROGRESS.md) so the Home teaser and
  // the Alerts screen never disagree, then report how many are open and their $ impact.
  await generateAlerts(supabase, businessId);
  const { count: alertsCount, data: alertRows } = await supabase
    .from("alerts")
    .select("impact_cents", { count: "exact" })
    .eq("business_id", businessId)
    .in("status", ["new", "seen"]);
  const leakingCents = (alertRows ?? []).reduce((sum, a) => sum + Math.max(0, a.impact_cents ?? 0), 0);

  return {
    business: { id: businessRow.id, name: businessRow.name, timezone, payrollTaxRate: Number(businessRow.payroll_tax_rate) },
    todayDateStr,
    monthKey,
    daysInMonth,
    monthActualDays,
    last28Days,
    last7Days,
    latestDay,
    previousMonthDays,
    runningCostLines,
    recoveryOrder: orderedCodes,
    menuItems,
    alerts: { count: alertsCount ?? 0, leakingCents },
  };
}

async function getMenuItemSnapshots(
  supabase: SupabaseClient,
  businessId: string,
  todayDateStr: string,
  last28DateStrs: string[],
): Promise<MenuItemSnapshot[]> {
  const { data: items, error: itemsError } = await supabase
    .from("menu_items")
    .select("id, name, price_cents, prep_seconds, category")
    .eq("business_id", businessId)
    .eq("is_active", true);
  if (itemsError) throw itemsError;
  if (!items || items.length === 0) return [];

  const itemIds = items.map((i) => i.id);

  const [{ data: recipeLines, error: recipeError }, { data: orderLines, error: linesError }] = await Promise.all([
    supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", itemIds),
    supabase
      .from("order_lines")
      .select("menu_item_id, quantity, voided, orders!inner(business_id, business_date)")
      .in("menu_item_id", itemIds)
      .eq("voided", false)
      .eq("orders.business_id", businessId)
      .gte("orders.business_date", last28DateStrs[0] ?? todayDateStr)
      .lte("orders.business_date", todayDateStr),
  ]);
  if (recipeError) throw recipeError;
  if (linesError) throw linesError;

  const ingredientIds = [...new Set((recipeLines ?? []).map((r) => r.ingredient_id))];
  const { data: priceRows, error: priceError } =
    ingredientIds.length > 0
      ? await supabase
          .from("ingredient_prices")
          .select("ingredient_id, effective_from, cost_per_base_unit_micros")
          .in("ingredient_id", ingredientIds)
          .lte("effective_from", todayDateStr)
          .order("effective_from", { ascending: true })
      : { data: [], error: null };
  if (priceError) throw priceError;

  const latestPriceMicros: Record<string, number> = {};
  for (const row of priceRows ?? []) {
    latestPriceMicros[row.ingredient_id] = row.cost_per_base_unit_micros; // ascending order -> last write wins
  }

  const quantityByItem: Record<string, number> = {};
  for (const line of orderLines ?? []) {
    quantityByItem[line.menu_item_id ?? ""] = (quantityByItem[line.menu_item_id ?? ""] ?? 0) + Number(line.quantity);
  }

  return items.map((item) => {
    const lines = (recipeLines ?? [])
      .filter((r) => r.menu_item_id === item.id)
      .map((r) => ({ ingredientId: r.ingredient_id, quantity: Number(r.quantity) }));
    return {
      id: item.id,
      name: item.name,
      priceCents: item.price_cents ?? 0,
      prepSeconds: item.prep_seconds,
      category: (item.category === "food" ? "food" : "drink") as "drink" | "food",
      ingredientsCentsToday: itemIngredientCostCents(lines, latestPriceMicros),
      quantitySoldLast28Days: quantityByItem[item.id] ?? 0,
    };
  });
}
