import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { buildDayWindows, evaluateRecipeCost, type ExpenseCategoryCode } from "@/lib/calc";
import { generateAlerts } from "@/lib/alerts/generate";
import { ensureScheduledShiftsThroughDate } from "./materializeSchedule";
import { RUNNING_COST_CODES, RUNNING_COST_LABELS, rowToDailyFacts } from "./runningCostCatalog";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessSnapshot, MenuItemSnapshot, RunningCostLine, StaffShift } from "./types";
import { isExpectedCostCategory } from "@/lib/expenses/expectedCosts";
import { normalizeOpenHours } from "@/lib/business/openHours";

/** Real Supabase-backed snapshot. Untested against a live project (see PROGRESS.md "Needs connecting"). */
export async function getBusinessSnapshotFromDb(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessSnapshot> {
  const { data: businessRow, error: businessError } = await supabase
    .from("businesses")
    .select("id, name, timezone, payroll_tax_rate, payroll_tax_rate_status, payroll_tax_rate_source, target_operating_margin, target_operating_margin_status")
    .eq("id", businessId)
    .single();
  if (businessError || !businessRow) throw new Error(`Business not found: ${businessId}`);

  const { data: locationRow, error: locationError } = await supabase
    .from("locations")
    .select("open_hours")
    .eq("business_id", businessId)
    .order("name", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (locationError) throw locationError;

  const timezone = businessRow.timezone;
  const todayDateStr = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");

  // Reconcile the owner's recurring schedules across the current month through today before
  // reading rollups. This picks up already-entered weekend schedules without requiring re-entry,
  // and existing manual/POS/imported timecards always win.
  await ensureScheduledShiftsThroughDate(supabase, businessId, timezone, todayDateStr);

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
      "business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, staff_tax_status, staff_tax_source, sales_data_status, card_fees_cents, card_fees_status, voids_cents",
    )
    .eq("business_id", businessId)
    .gte("business_date", prevMonthStart)
    .lte("business_date", todayDateStr)
    .order("business_date", { ascending: true });
  if (rollupError) throw rollupError;

  const allDays = (rollupRows ?? []).map(rowToDailyFacts);
  const { monthRecordedDays, monthActualDays, last7Days, last28Days, todayDay, todayHasData } = buildDayWindows(allDays, todayDateStr, monthKey);
  const previousMonthDays = allDays.filter(
    (d) => d.date >= prevMonthStart && d.date <= prevMonthEnd && d.salesDataStatus !== "missing",
  );

  const [recurringResult, expensesResult, priorExpenseResult, recoveryOrderResult] = await Promise.all([
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
    supabase.from("expenses").select("category_code").eq("business_id", businessId).gte("spent_on", prevMonthStart).lte("spent_on", prevMonthEnd),
    supabase
      .from("recovery_order")
      .select("bucket_code, position")
      .eq("business_id", businessId)
      .order("position", { ascending: true }),
  ]);
  if (recurringResult.error) throw recurringResult.error;
  if (expensesResult.error) throw expensesResult.error;
  if (priorExpenseResult.error) throw priorExpenseResult.error;
  if (recoveryOrderResult.error) throw recoveryOrderResult.error;

  const recoveryOrder = (recoveryOrderResult.data ?? []).map((r) => r.bucket_code);
  const orderedCodes = recoveryOrder.length > 0 ? recoveryOrder : RUNNING_COST_CODES;

  const runningCostLines: RunningCostLine[] = orderedCodes
    .filter((code): code is ExpenseCategoryCode => RUNNING_COST_CODES.includes(code as ExpenseCategoryCode))
    .map((code) => {
      // A category (most often "other") can have more than one active recurring-cost row — e.g.
      // several distinct labeled bills that don't fit a fixed category — so every active row
      // must be summed, not just the first one found.
      const activeRecurring = (recurringResult.data ?? []).filter(
        (r) => r.category_code === code && r.active_from <= todayDateStr && (!r.active_to || r.active_to >= todayDateStr),
      );
      const expensesThisMonth = (expensesResult.data ?? []).filter((e) => e.category_code === code);
      const isExpected = isExpectedCostCategory(code, {
        hasActiveRecurring: activeRecurring.length > 0,
        hadActualPreviousMonth: (priorExpenseResult.data ?? []).some((expense) => expense.category_code === code),
      });

      if (expensesThisMonth.length > 0) {
        return {
          categoryCode: code,
          label: RUNNING_COST_LABELS[code] ?? code,
          amountCents: expensesThisMonth.reduce((sum, e) => sum + e.amount_cents, 0),
          isEstimate: expensesThisMonth.some((e) => e.status === "estimated"),
          isMissing: false,
          isExpected: true,
        };
      }
      if (activeRecurring.length > 0) {
        return {
          categoryCode: code,
          label: RUNNING_COST_LABELS[code] ?? code,
          amountCents: activeRecurring.reduce((sum, r) => sum + r.amount_cents, 0),
          isEstimate: activeRecurring.some((r) => r.is_estimate),
          isMissing: false,
          isExpected: true,
        };
      }
      return { categoryCode: code, label: RUNNING_COST_LABELS[code] ?? code, amountCents: 0, isEstimate: false, isMissing: isExpected, isExpected };
    });

  const menuItems = await getMenuItemSnapshots(supabase, businessId, todayDateStr, last28Days.map((d) => d.date));
  const staffShiftsToday = await getStaffShiftsToday(supabase, businessId, timezone, todayDateStr);

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
    business: {
      id: businessRow.id,
      name: businessRow.name,
      timezone,
      payrollTaxRate: Number(businessRow.payroll_tax_rate),
      payrollTaxRateStatus: businessRow.payroll_tax_rate_status ?? "estimated",
      payrollTaxRateSource: businessRow.payroll_tax_rate_source ?? "system_estimate",
      targetOperatingMargin: Number(businessRow.target_operating_margin ?? 0.15),
      targetOperatingMarginStatus: businessRow.target_operating_margin_status ?? "default",
      openHours: normalizeOpenHours(locationRow?.open_hours),
    },
    todayDateStr,
    monthKey,
    daysInMonth,
    monthRecordedDays,
    monthActualDays,
    last28Days,
    last7Days,
    todayDay,
    todayHasData,
    previousMonthDays,
    runningCostLines,
    recoveryOrder: orderedCodes,
    menuItems,
    alerts: { count: alertsCount ?? 0, leakingCents },
    staffShiftsToday,
    staffNowIso: new Date().toISOString(),
  };
}

/** All of today's timecards (business-timezone calendar day), joined to the employee's name/role. */
async function getStaffShiftsToday(
  supabase: SupabaseClient,
  businessId: string,
  timezone: string,
  todayDateStr: string,
): Promise<StaffShift[]> {
  const dayStartUtc = fromZonedTime(`${todayDateStr}T00:00:00`, timezone).toISOString();
  const dayEndUtc = fromZonedTime(`${todayDateStr}T23:59:59.999`, timezone).toISOString();

  const { data, error } = await supabase
    .from("timecards")
    .select("id, employee_id, schedule_id, clock_in, clock_out, hourly_wage_cents, breaks, employees(display_name, role)")
    .eq("business_id", businessId)
    .gte("clock_in", dayStartUtc)
    .lte("clock_in", dayEndUtc)
    .order("clock_in", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((row) => {
    const employee = row.employees as unknown as { display_name: string; role: string | null } | { display_name: string; role: string | null }[] | null;
    const emp = Array.isArray(employee) ? employee[0] : employee;
    return {
      employeeId: row.employee_id ?? row.id,
      name: emp?.display_name ?? "Staff",
      role: emp?.role ?? null,
      timecard: {
        clockIn: row.clock_in,
        clockOut: row.clock_out,
        hourlyWageCents: row.hourly_wage_cents,
        breaks: (row.breaks as { start: string; end: string; paid: boolean }[]) ?? [],
        scheduleId: row.schedule_id,
      },
    };
  });
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

  const [{ data: recipeLines, error: recipeError }, { data: quantitySoldRows, error: quantityError }] = await Promise.all([
    supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", itemIds),
    supabase.rpc("menu_item_quantities_sold", {
      p_business_id: businessId,
      p_from: last28DateStrs[0] ?? todayDateStr,
      p_to: todayDateStr,
    }),
  ]);
  if (quantityError) throw quantityError;
  if (recipeError) throw recipeError;

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
  for (const row of quantitySoldRows ?? []) {
    quantityByItem[row.menu_item_id] = Number(row.total_quantity);
  }

  return items.map((item) => {
    const lines = (recipeLines ?? [])
      .filter((r) => r.menu_item_id === item.id)
      .map((r) => ({ ingredientId: r.ingredient_id, quantity: Number(r.quantity) }));
    const recipeCost = evaluateRecipeCost(lines, latestPriceMicros);
    const ingredientsCentsToday = recipeCost.costCents ?? 0;
    return {
      id: item.id,
      name: item.name,
      priceCents: item.price_cents ?? 0,
      prepSeconds: item.prep_seconds,
      category: (item.category === "food" ? "food" : "drink") as "drink" | "food",
      ingredientsCentsToday,
      // Lines with no priced ingredient cost 0 by default, not because the drink is actually
      // free to make — flag it as incomplete so the UI doesn't show a false 100% margin.
      hasRecipe: lines.length > 0,
      costStatus: recipeCost.status,
      quantitySoldLast28Days: quantityByItem[item.id] ?? 0,
    };
  });
}
