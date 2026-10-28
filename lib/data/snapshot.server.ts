import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { buildDayWindows, evaluateRecipeCost, resolveProductCost, type ExpenseCategoryCode } from "@/lib/calc";
import { generateAlerts } from "@/lib/alerts/generate";
import { ensureScheduledShiftsThroughDate } from "./materializeSchedule";
import { RUNNING_COST_CODES, RUNNING_COST_LABELS, rowToDailyFacts } from "./runningCostCatalog";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessSnapshot, MenuItemSnapshot, RunningCostLine, StaffShift } from "./types";
import { isExpectedCostCategory } from "@/lib/expenses/expectedCosts";
import { normalizeOpenHours } from "@/lib/business/openHours";
import { readPeriodItemSales } from "./periodItemSales.server";
import {readMenuComboCostComponents} from "./comboCosts.server";
import {resolveComboCosts} from "@/lib/calc/comboCostResolution";
import {getOwnerConfirmedProcessingFeePlans} from "@/lib/pos/processingFeeEstimate.server";
import type {OwnerFeePlan} from "@/lib/metrics/core/fees";

/** Real Supabase-backed snapshot. Untested against a live project (see PROGRESS.md "Needs connecting"). */
export async function getBusinessSnapshotFromDb(
  supabase: SupabaseClient,
  businessId: string,
  costPeriod: "today"|"week"|"month"="month",
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
      "business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, labor_wage_status, staff_tax_status, staff_tax_source, sales_data_status, card_fees_cents, card_fees_status, voids_cents",
    )
    .eq("business_id", businessId)
    .gte("business_date", prevMonthStart)
    .lte("business_date", todayDateStr)
    .order("business_date", { ascending: true });
  if (rollupError) throw rollupError;

  const allDays = (rollupRows ?? []).map(rowToDailyFacts);
  const { monthRecordedDays, monthActualDays, last7Days, last28Days, todayDay, todayHasData } = buildDayWindows(allDays, todayDateStr, monthKey);
  const previousMonthRecordedDays=allDays.filter(d=>
    d.date>=prevMonthStart&&d.date<=prevMonthEnd);
  const previousMonthDays=previousMonthRecordedDays.filter(d=>
    d.salesDataStatus!=="missing");

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

  const allMenuItemSnapshots = await getMenuItemSnapshots(supabase, businessId, todayDateStr, last28Days.map((d) => d.date));
  // Requested window, not last28Days and not the currently active menu.
  const minusSix=new Date(Date.parse(todayDateStr+"T12:00:00Z")-6*86_400_000).toISOString().slice(0,10);
  const periodFrom=costPeriod==="today"?todayDateStr:costPeriod==="week"?minusSix:monthStart;
  const periodItemSales=await readPeriodItemSales(supabase,businessId,
    {from:periodFrom,to:todayDateStr});
  const menuItems = allMenuItemSnapshots.filter((item) => item.active !== false);
  const breakEvenProductCosts = allMenuItemSnapshots.filter((item) => item.quantitySoldLast28Days > 0);
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

  const ownerFeePlans=await getOwnerConfirmedProcessingFeePlans(supabase,businessId);
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
    previousMonthRecordedDays,
    runningCostLines,
    recoveryOrder: orderedCodes,
    menuItems,
    allCostProducts:allMenuItemSnapshots,
    periodItemSales,
    breakEvenProductCosts,
    alerts: { count: alertsCount ?? 0, leakingCents },
    staffShiftsToday,
    staffNowIso: new Date().toISOString(),
    ownerFeePlans,
  } as BusinessSnapshot;
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
    .select("id, employee_id, schedule_id, source_type, source_provider, clock_in, clock_out, hourly_wage_cents, breaks, employees(display_name, role)")
    .eq("business_id", businessId)
    .gte("clock_in", dayStartUtc)
    .lte("clock_in", dayEndUtc)
    .order("clock_in", { ascending: true });
  if (error) throw error;
  // Preserve every recorded timecard for earned wages, including staff who were
  // deactivated later today and imports not yet linked to a roster member.
  // Current-roster filtering belongs ONLY in buildStaffViewModel.onShift.
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
        sourceType: row.source_type,
        sourceProvider: row.source_provider,
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
    .select("id, name, price_cents, prep_seconds, category, is_active")
    .eq("business_id", businessId);
  if (itemsError) throw itemsError;
  if (!items || items.length === 0) return [];

  const itemIds = items.map((i) => i.id);

  const [{ data: recipeLines, error: recipeError }, { data: quantitySoldRows, error: quantityError }, { data: aggregateCosts, error: aggregateCostError }] = await Promise.all([
    supabase.from("recipe_lines").select("menu_item_id, ingredient_id, quantity").in("menu_item_id", itemIds),
    supabase.rpc("menu_item_quantities_sold", {
      p_business_id: businessId,
      p_from: last28DateStrs[0] ?? todayDateStr,
      p_to: todayDateStr,
    }),
    supabase.from("menu_item_cost_fallbacks").select("menu_item_id, cost_cents, status").eq("business_id", businessId).in("menu_item_id", itemIds),
  ]);
  if (quantityError) throw quantityError;
  if (recipeError) throw recipeError;
  if (aggregateCostError) throw aggregateCostError;

  const ingredientIds = [...new Set((recipeLines ?? []).map((r) => r.ingredient_id))];
  const { data: priceRows, error: priceError } =
    ingredientIds.length > 0
      ? await supabase
          .from("ingredient_prices")
          .select("ingredient_id, effective_from, cost_per_base_unit_micros")
          .in("ingredient_id", ingredientIds)
          .lte("effective_from", todayDateStr)
          .order("effective_from", { ascending: true }).order("recorded_at", { ascending: true }).order("id", { ascending: true })
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
  const aggregateByItem = new Map((aggregateCosts ?? []).map((row) => [row.menu_item_id, row]));


  const baseCosts=new Map(items.map(item=>{
    const lines=(recipeLines??[]).filter(r=>r.menu_item_id===item.id)
      .map(r=>({ingredientId:r.ingredient_id,quantity:Number(r.quantity)}));
    const aggregate=aggregateByItem.get(item.id);
    const resolved=resolveProductCost(evaluateRecipeCost(lines,latestPriceMicros),aggregate?Number(aggregate.cost_cents):null);
    return[item.id,{
      costCents:resolved.costCents,status:resolved.status,
      estimated:resolved.source==="owner_total"&&aggregate?.status==="estimated",
    }] as const;
  }));
  const comboRows=await readMenuComboCostComponents(supabase,businessId,itemIds);
  const comboCosts=resolveComboCosts(comboRows,baseCosts);

  return items.map((item) => {
    const lines = (recipeLines ?? [])
      .filter((r) => r.menu_item_id === item.id)
      .map((r) => ({ ingredientId: r.ingredient_id, quantity: Number(r.quantity) }));
    const recipeCost = evaluateRecipeCost(lines, latestPriceMicros);
    const aggregate = aggregateByItem.get(item.id);
    const resolvedCost = resolveProductCost(recipeCost, aggregate ? Number(aggregate.cost_cents) : null);
    const combo=comboCosts.get(item.id);
    const currentStatus=combo?.status??resolvedCost.status;
    const ingredientsCentsToday = (combo?combo.costCents:resolvedCost.costCents) ?? 0;
    const costQuality =
      currentStatus !== "READY"
        ? null
        : combo?.estimated || (!combo && resolvedCost.source === "owner_total" && aggregate?.status === "estimated")
          ? "estimated" as const
          : "actual" as const;
    return {
      id: item.id,
      name: item.name,
      priceCents: item.price_cents ?? 0,
      prepSeconds: item.prep_seconds,
      category: (item.category === "food" ? "food" : "drink") as "drink" | "food",
      active: item.is_active,
      ingredientsCentsToday,
      // Lines with no priced ingredient cost 0 by default, not because the drink is actually
      // free to make — flag it as incomplete so the UI doesn't show a false 100% margin.
      hasRecipe: lines.length > 0 || Boolean(combo),
      costStatus: currentStatus,
      costSource: combo ? "combo" : resolvedCost.source,
      recipeCostCents: combo ? null : recipeCost.costCents,
      recipeCostStatus: combo?.status ?? recipeCost.status,
      ownerTotalCostCents: resolvedCost.ownerTotalCostCents,
      costDifferenceCents: resolvedCost.differenceCents,
      costQuality,
      quantitySoldLast28Days: quantityByItem[item.id] ?? 0,
    };
  });
}


/** Read-only historical snapshot for a café-scoped arbitrary range. Never call
 * materializeScheduledShifts, generateAlerts, or any snapshot write path here.
 * Monthly cost lines retain their own month provenance across month boundaries.
 */
async function readHistoricalBusinessSnapshot(
  supabase:SupabaseClient,businessId:string,period:{from:string;to:string},
):Promise<BusinessSnapshot & {ownerFeePlans:OwnerFeePlan[];historicalPeriod:{
  days:import("@/lib/calc").DailyFacts[];
  recorded:import("@/lib/calc").DailyFacts[];
  monthlyAmounts:import("@/lib/calc").CategoryMonthlyAmount[];
  missingExpenseCategories:string[];
  estimatedExpenseCategories:string[];
}}>{
  if(!businessId||!/^\d{4}-\d{2}-\d{2}$/.test(period.from)||
    !/^\d{4}-\d{2}-\d{2}$/.test(period.to)||period.from>period.to)
    throw new Error("Invalid historical café period");
  const {data:business,error:businessError}=await supabase.from("businesses")
    .select("id,name,timezone,payroll_tax_rate,payroll_tax_rate_status,payroll_tax_rate_source,target_operating_margin,target_operating_margin_status")
    .eq("id",businessId).single();
  if(businessError||!business||!business.timezone)throw new Error("Historical café scope unavailable");
  const today=formatInTimeZone(new Date(),business.timezone,"yyyy-MM-dd");
  if(period.to>today)throw new Error("Historical period in future");
  const first=period.from.slice(0,7)+"-01";
  const last=period.to.slice(0,7);
  const [year,month]=last.split("-").map(Number);
  const monthEnd=last+"-"+String(new Date(year,month,0).getDate()).padStart(2,"0");
  const [rollups,recurring,expenses,locations,itemSales]=await Promise.all([
    supabase.from("daily_rollups")
      .select("business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,staff_wages_cents,staff_tax_cents,labor_wage_status,staff_tax_status,staff_tax_source,sales_data_status,card_fees_cents,card_fees_status,voids_cents")
      .eq("business_id",businessId).gte("business_date",period.from)
      .lte("business_date",period.to).order("business_date",{ascending:true}).limit(4000),
    supabase.from("recurring_costs")
      .select("category_code,amount_cents,is_estimate,active_from,active_to")
      .eq("business_id",businessId).lte("active_from",period.to),
    supabase.from("expenses").select("category_code,amount_cents,status,spent_on")
      .eq("business_id",businessId).gte("spent_on",first).lte("spent_on",monthEnd).limit(4000),
    supabase.from("locations").select("open_hours")
      .eq("business_id",businessId).order("name",{ascending:true}).limit(1),
    readPeriodItemSales(supabase,businessId,period),
  ]);
  for(const result of [rollups,recurring,expenses,locations])
    if(result.error)throw result.error;
  // PostgreSQL / PostgREST defaults to a 1,000 row cap. Fail closed on possibly
  // truncated windows rather than representing an incomplete return as complete.
  if((rollups.data??[]).length>=4000||(expenses.data??[]).length>=4000)
    throw new Error("Historical period exceeds the supported read window");
  const recorded=(rollups.data??[]).map(rowToDailyFacts);
  const sales=recorded.filter(d=>d.salesDataStatus!=="missing");
  const months:string[]=[];
  let cursor=first;
  while(cursor<=last+"-01"){
    months.push(cursor.slice(0,7));
    const [y,m]=cursor.split("-").map(Number);
    const next=new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);
    cursor=next+"-01";
    if(months.length>120)throw new Error("Historical period exceeds 120 months");
  }
  const monthlyAmounts:import("@/lib/calc").CategoryMonthlyAmount[]=[];
  const missingExpenseCategories:string[]=[];
  const estimatedExpenseCategories:string[]=[];
  const relevantCodes=RUNNING_COST_CODES;
  for(const key of months){
    const finalDay=key+"-"+String(new Date(Number(key.slice(0,4)),Number(key.slice(5,7)),0)
      .getDate()).padStart(2,"0");
    for(const categoryCode of relevantCodes){
      const actual=(expenses.data??[]).filter(r=>r.category_code===categoryCode&&
        r.spent_on>=key+"-01"&&r.spent_on<=finalDay);
      const configured=(recurring.data??[]).filter(r=>r.category_code===categoryCode&&
        r.active_from<=finalDay&&(!r.active_to||r.active_to>=key+"-01"));
      const rows=actual.length?actual:configured;
      const amountCents=rows.reduce((sum,r)=>sum+Number(r.amount_cents),0);
      const isEstimate=actual.length?actual.some(r=>r.status==="estimated"):
        configured.some(r=>r.is_estimate);
      const isMissing=rows.length===0;
      monthlyAmounts.push({monthKey:key,categoryCode,amountCents,isEstimate,isMissing});
      if(isEstimate)estimatedExpenseCategories.push("expense:"+categoryCode+":"+key);
      if(isMissing&&((recurring.data??[]).some(r=>r.category_code===categoryCode)||
        (expenses.data??[]).some(r=>r.category_code===categoryCode)))
        missingExpenseCategories.push("expense:"+categoryCode+":"+key);
    }
  }
  const monthKey=last;
  const lastAmounts=monthlyAmounts.filter(r=>r.monthKey===monthKey);
  const runningCostLines:RunningCostLine[]=lastAmounts.map(line=>({
    categoryCode:line.categoryCode as ExpenseCategoryCode,
    label:RUNNING_COST_LABELS[line.categoryCode as ExpenseCategoryCode]??line.categoryCode,
    amountCents:line.amountCents,isEstimate:line.isEstimate,
    isMissing:line.isMissing,isExpected:missingExpenseCategories.some(x=>x.startsWith("expense:"+line.categoryCode+":")),
  }));
  const ownerFeePlans=await getOwnerConfirmedProcessingFeePlans(supabase,businessId);
  return {
    business:{id:business.id,name:business.name,timezone:business.timezone,
      payrollTaxRate:Number(business.payroll_tax_rate),
      payrollTaxRateStatus:business.payroll_tax_rate_status,
      payrollTaxRateSource:business.payroll_tax_rate_source,
      targetOperatingMargin:Number(business.target_operating_margin??.15),
      targetOperatingMarginStatus:business.target_operating_margin_status,
      openHours:normalizeOpenHours(locations.data?.[0]?.open_hours)},
    todayDateStr:today,monthKey,daysInMonth:new Date(year,month,0).getDate(),
    monthActualDays:sales.filter(d=>d.date.slice(0,7)===monthKey),
    monthRecordedDays:recorded.filter(d=>d.date.slice(0,7)===monthKey),
    last28Days:[],last7Days:[],
    todayDay:recorded.find(d=>d.date===today)??{
      date:today,netSalesCents:0,ordersCount:0,drinksCount:0,ingredientsCents:0,
      wagesCents:null,staffTaxCents:null,cardFeesCents:0,voidsCents:0,
      salesDataStatus:"missing" as const,cardFeesStatus:"missing" as const,
    },
    todayHasData:recorded.some(d=>d.date===today&&d.salesDataStatus!=="missing"),
    previousMonthDays:sales.filter(d=>d.date.slice(0,7)!==monthKey),
    previousMonthRecordedDays:recorded.filter(d=>d.date.slice(0,7)!==monthKey),
    runningCostLines,recoveryOrder:RUNNING_COST_CODES,
    menuItems:[],allCostProducts:[],periodItemSales:itemSales,breakEvenProductCosts:[],
    alerts:{count:0,leakingCents:0},staffShiftsToday:[],staffNowIso:new Date().toISOString(),
    historicalPeriod:{days:sales,recorded,monthlyAmounts,
      missingExpenseCategories,estimatedExpenseCategories},
    ownerFeePlans,
  };
}

// The existing snapshot export remains the public source boundary and owns the
// read-only historical method. Do not introduce an unclassified new data export.
getBusinessSnapshotFromDb.readHistorical=readHistoricalBusinessSnapshot;
