import "server-only";
import {readDailyFactRows} from "./dailyFacts.server";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { buildDayWindows, evaluateRecipeCost, resolveProductCost } from "@/lib/calc";
import { runningCostLinesForMonth, runningCostMonthlyAmount, rowToDailyFacts } from "./runningCostCatalog";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessSnapshot, MenuItemSnapshot, RunningCostLine, StaffShift } from "./types";
import { normalizeOpenHours } from "@/lib/business/openHours";
import { readPeriodItemSales } from "./periodItemSales.server";
import {readMenuComboCostComponents} from "./comboCosts.server";
import {resolveComboCosts} from "@/lib/calc/comboCostResolution";
import {getOwnerConfirmedProcessingFeePlans} from "@/lib/pos/processingFeeEstimate.server";
import type {OwnerFeePlan} from "@/lib/metrics/core/fees";
import {shiftCafeDate} from "@/lib/metrics/core/clock";
import {hasSalesCoverage} from "@/lib/calc/dayWindows";
import {timeReader} from "@/lib/perf/timeReader.server";
import {readCompletePaged} from "./completePages";

/** Same authorized PostgREST read as the Home/Money screens, but through all
 * pages, not the default 1,000-row partial slice. Callers supply stable ordering
 * and business/date scope; any ambiguous page fails closed, never as zero cost. */
async function snapshotPaged<T>(
 label:string,
 fetch:(start:number,end:number)=>PromiseLike<{data:T[]|null;error:unknown;count?:number|null}>,
 identity:(row:T)=>unknown
):Promise<{data:T[];error:null;count:number}>{
 const data=await readCompletePaged(fetch,identity);
 if(data===null)throw new Error("snapshot_source_incomplete:"+label);
 return {data,error:null,count:data.length};
}


/** Real Supabase-backed snapshot. Untested against a live project (see PROGRESS.md "Needs connecting"). */
export async function getBusinessSnapshotFromDb(
  supabase: SupabaseClient,
  businessId: string,
  costPeriod: "today"|"week"|"month"|{from:string;to:string}="month",
  asOfDate?:string,
): Promise<BusinessSnapshot> {
  // Historical range is a read-only mode of the existing classified source.
  // Never reach shift-materialization or alert-generation writes in this path.
  if(typeof costPeriod==="object")
    return readHistoricalBusinessSnapshot(supabase,businessId,costPeriod);
  const [businessRead,locationRead]=await Promise.all([
    timeReader("Snapshot","business",async()=>supabase.from("businesses").select(
      "id, name, timezone, currency, payroll_tax_rate, payroll_tax_rate_status, payroll_tax_rate_source, target_operating_margin, target_operating_margin_status, target_ingredient_cost_rate, target_ingredient_cost_rate_status, owner_monthly_payroll_extras_cents")
      .eq("id",businessId).single()),
    timeReader("Snapshot","location",async()=>supabase.from("locations").select("open_hours").eq("business_id",businessId)
      .order("name",{ascending:true}).limit(1).maybeSingle()),
  ]);
  const {data:businessRow,error:businessError}=businessRead;
  const {data:locationRow,error:locationError}=locationRead;
  if(businessError||!businessRow||!businessRow.timezone)throw new Error("Business unavailable");
  if(locationError)throw locationError;
  const timezone = businessRow.timezone;
  const todayDateStr = asOfDate??formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");

  const monthKey = todayDateStr.slice(0, 7);
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = `${monthKey}-01`;
  const prevMonthDate = new Date(year, month - 2, 1);
  const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const prevMonthStart = `${prevMonthKey}-01`;
  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  const prevMonthEnd = `${prevMonthKey}-${String(prevMonthDays).padStart(2, "0")}`;

  // All of these are independent once the café's timezone fixes the date window.
  // Start item cost, staff, alert and fee evidence alongside daily/cost reads,
  // instead of serializing two database waves. Every read remains RLS-scoped.
  const minusSix=new Date(Date.parse(todayDateStr+"T12:00:00Z")-6*86_400_000).toISOString().slice(0,10);
  const periodFrom=costPeriod==="today"?todayDateStr:costPeriod==="week"?minusSix:monthStart;
  const [rollupResult,recurringResult,expensesResult,priorExpenseResult,recoveryOrderResult,
    allMenuItemSnapshots,periodItemSales,staffShiftsToday,alertsRead,ownerFeePlans]=
    await Promise.all([
      timeReader("Snapshot","dailyFacts",()=>readDailyFactRows(supabase,businessId,prevMonthStart,todayDateStr))
        .then(data=>({data,error:null}),(error:Error)=>({data:null,error})),
      timeReader("Snapshot","recurringCosts",()=>snapshotPaged("recurring_costs",
        (start,end)=>supabase.from("recurring_costs")
         .select("id,category_code,amount_cents,frequency,is_estimate,active_from,active_to,label,due_day,source",{count:"exact"})
         .eq("business_id",businessId).order("id",{ascending:true}).range(start,end),
        row=>row.id)),
      timeReader("Snapshot","expenses",()=>snapshotPaged("expenses",
        (start,end)=>supabase.from("expenses")
         .select("id,category_code,amount_cents,status,spent_on,recurring_cost_id,custom_label,vendor,source",{count:"exact"})
         .eq("business_id",businessId).gte("spent_on",monthStart).lte("spent_on",todayDateStr)
         .order("id",{ascending:true}).range(start,end),
        row=>row.id)),
      timeReader("Snapshot","priorExpenses",()=>snapshotPaged("prior_expenses",
        (start,end)=>supabase.from("expenses")
         .select("id,category_code,amount_cents,status,spent_on,recurring_cost_id,custom_label,vendor,source",{count:"exact"})
         .eq("business_id",businessId).gte("spent_on",prevMonthStart).lte("spent_on",prevMonthEnd)
         .order("id",{ascending:true}).range(start,end),
        row=>row.id)),
      timeReader("Snapshot","recoveryOrder",async()=>supabase.from("recovery_order")
        .select("bucket_code, position").eq("business_id",businessId).order("position",{ascending:true})),
      timeReader("Snapshot","menuCosts",()=>getMenuItemSnapshots(supabase,businessId,todayDateStr)),
      timeReader("Snapshot","periodItemSales",()=>readPeriodItemSales(supabase,businessId,{from:periodFrom,to:todayDateStr})),
      timeReader("Snapshot","staffShifts",()=>getStaffShiftsToday(supabase,businessId,timezone,todayDateStr)),
      timeReader("Snapshot","alerts",()=>snapshotPaged("alerts",
        (start,end)=>supabase.from("alerts").select("id,impact_cents",{count:"exact"})
         .eq("business_id",businessId).in("status",["new","seen"])
         .order("id",{ascending:true}).range(start,end),
        row=>row.id)),
      timeReader("Snapshot","feePlans",()=>getOwnerConfirmedProcessingFeePlans(supabase,businessId)),
    ]);
  const {data:rollupRows,error:rollupError}=rollupResult;
  if(rollupError)throw rollupError;
  const allDays=(rollupRows??[]).map(rowToDailyFacts);
  const {monthRecordedDays,monthActualDays,last7Days,last28Days,todayDay,todayHasData}=
    buildDayWindows(allDays,todayDateStr,monthKey);
  const breakEvenDays=allDays.filter(d=>d.date>=shiftCafeDate(todayDateStr,-28)&&
    d.date<todayDateStr&&hasSalesCoverage(d));
  const previousMonthRecordedDays=allDays.filter(d=>d.date>=prevMonthStart&&d.date<=prevMonthEnd);
  const previousMonthDays=previousMonthRecordedDays.filter(d=>d.salesDataStatus!=="missing");
  if (recurringResult.error) throw recurringResult.error;
  if (expensesResult.error) throw expensesResult.error;
  if (priorExpenseResult.error) throw priorExpenseResult.error;
  if (recoveryOrderResult.error) throw recoveryOrderResult.error;

  const recoveryOrder = (recoveryOrderResult.data ?? []).map((r) => r.bucket_code);
  const runningCostLines=runningCostLinesForMonth({expenses:expensesResult.data,recurring:recurringResult.data,
    priorExpenses:priorExpenseResult.data,from:monthStart,to:monthKey+"-"+String(daysInMonth).padStart(2,"0"),today:todayDateStr,
    historical:false,order:recoveryOrder});
  const previousRunningCostLines=runningCostLinesForMonth({expenses:priorExpenseResult.data,recurring:recurringResult.data,
    from:prevMonthStart,to:prevMonthEnd,today:prevMonthEnd,historical:true,order:recoveryOrder});
  const orderedCodes=[...new Set([...runningCostLines,...previousRunningCostLines].map(line=>line.categoryCode))];

  // Requested period, not last28Days, remains the item-cost evidence boundary.
  if(alertsRead.error)throw alertsRead.error;
  const menuItems=allMenuItemSnapshots.filter(item=>item.active!==false);
  const breakEvenProductCosts=allMenuItemSnapshots.filter(item=>item.quantitySoldLast28Days>0);
  const alertsCount=alertsRead.count;
  const leakingCents=(alertsRead.data??[]).reduce((sum,alert)=>
    sum+Math.max(0,alert.impact_cents??0),0);

  return {
    business: {
      id: businessRow.id,
      name: businessRow.name,
      timezone,
      currency:businessRow.currency??null,
      payrollTaxRate: Number(businessRow.payroll_tax_rate),
      payrollTaxRateStatus: businessRow.payroll_tax_rate_status ?? "estimated",
      payrollTaxRateSource: businessRow.payroll_tax_rate_source ?? "system_estimate",
      targetOperatingMargin: Number(businessRow.target_operating_margin ?? 0.15),
      targetOperatingMarginStatus: businessRow.target_operating_margin_status ?? "default",
       targetIngredientCostRate:businessRow.target_ingredient_cost_rate==null?null:Number(businessRow.target_ingredient_cost_rate),
       targetIngredientCostRateStatus:businessRow.target_ingredient_cost_rate_status??null,
      openHours: normalizeOpenHours(locationRow?.open_hours),
    },
    todayDateStr,
    monthKey,
    daysInMonth,
    monthRecordedDays,
    monthActualDays,
    last28Days,
    breakEvenDays,
    last7Days,
    todayDay,
    todayHasData,
    previousMonthDays,
    previousMonthRecordedDays,
    runningCostLines,
    previousRunningCostLines,
    recoveryOrder: orderedCodes,
    menuItems,
    allCostProducts:allMenuItemSnapshots,
    periodItemSales,
    breakEvenProductCosts,
    alerts: { count: alertsCount ?? 0, leakingCents },
    staffShiftsToday,
    staffNowIso: new Date().toISOString(),
    ownerFeePlans,
    ownerMonthlyPayrollExtrasCents:businessRow.owner_monthly_payroll_extras_cents===null?
      null:Number(businessRow.owner_monthly_payroll_extras_cents),
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

  const {data}=await snapshotPaged("timecards",
    (start,end)=>supabase.from("timecards")
     .select("id,employee_id,schedule_id,source_type,source_provider,clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,employees(display_name,role)",{count:"exact"})
     .eq("business_id",businessId).gte("clock_in",dayStartUtc).lte("clock_in",dayEndUtc)
     .order("clock_in",{ascending:true}).order("id",{ascending:true})
     .range(start,end),row=>row.id);
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
        providerRegularHours: row.provider_regular_hours == null ? null : Number(row.provider_regular_hours),
        providerOvertimeHours: row.provider_overtime_hours == null ? null : Number(row.provider_overtime_hours),
      },
    };
  });
}

async function getMenuItemSnapshots(
  supabase: SupabaseClient,
  businessId: string,
  todayDateStr: string,
): Promise<MenuItemSnapshot[]> {
  const {data:items}=await snapshotPaged("menu_items",
    (start,end)=>supabase.from("menu_items")
     .select("id,name,price_cents,prep_seconds,category,is_active",{count:"exact"})
     .eq("business_id",businessId).order("id",{ascending:true}).range(start,end),
     row=>row.id);
  if (!items || items.length === 0) return [];

  const itemIds = items.map((i) => i.id);

  // Source IDs remain scoped to this café and batch sizes bound URL length.
  // Page each batch by immutable source identity; any incomplete source fails
  // closed, never as a fabricated zero quantity or missing recipe ingredient.
  const recipeLines:Array<{menu_item_id:string;ingredient_id:string;quantity:number}>=[];
  const aggregateCosts:Array<{menu_item_id:string;cost_cents:number|null;status:string}>=[];
  const {data:quantitySoldRows}=await snapshotPaged<{
    menu_item_id:string;total_quantity:number|string
  }>("menu_item_quantities_sold",async(start,end)=>{
     const page=await supabase.rpc("menu_item_quantities_sold",{
       p_business_id:businessId,
       p_from:shiftCafeDate(todayDateStr,-28),p_to:shiftCafeDate(todayDateStr,-1)
     },{count:"exact"}).order("menu_item_id",{ascending:true}).range(start,end);
     return {...page,data:page.data as
       Array<{menu_item_id:string;total_quantity:number|string}>|null};
  },row=>row.menu_item_id);
  const knownItems=new Set(itemIds);
  if(quantitySoldRows.some(row=>!knownItems.has(row.menu_item_id)||
    !Number.isSafeInteger(Number(row.total_quantity))||Number(row.total_quantity)<0))
    throw new Error("snapshot_product_sales_mapping_unverified");
  for(let i=0;i<itemIds.length;i+=100){
    const batch=itemIds.slice(i,i+100);
    const [recipes,costs]=await Promise.all([
      snapshotPaged("recipe_lines",(start,end)=>supabase.from("recipe_lines")
        .select("menu_item_id,ingredient_id,quantity",{count:"exact"})
        .in("menu_item_id",batch).order("menu_item_id",{ascending:true})
        .order("ingredient_id",{ascending:true}).range(start,end),
        row=>row.menu_item_id+":"+row.ingredient_id),
      snapshotPaged("menu_item_cost_fallbacks",(start,end)=>supabase.from("menu_item_cost_fallbacks")
        .select("menu_item_id,cost_cents,status",{count:"exact"})
        .eq("business_id",businessId).in("menu_item_id",batch)
        .order("menu_item_id",{ascending:true}).range(start,end),
        row=>row.menu_item_id),
    ]);
    recipeLines.push(...recipes.data);
    aggregateCosts.push(...costs.data);
  }

  const ingredientIds=[...new Set(recipeLines.map(row=>row.ingredient_id))];
  const priceRows:Array<{id:string;ingredient_id:string;effective_from:string;
    recorded_at:string;cost_per_base_unit_micros:number}>=[];
  for(let i=0;i<ingredientIds.length;i+=100){
    const batch=ingredientIds.slice(i,i+100);
    const page=await snapshotPaged("ingredient_prices",(start,end)=>
      supabase.from("ingredient_prices")
       .select("id,ingredient_id,effective_from,recorded_at,cost_per_base_unit_micros",
         {count:"exact"})
       .in("ingredient_id",batch).lte("effective_from",todayDateStr)
       .order("id",{ascending:true}).range(start,end),row=>row.id);
    priceRows.push(...page.data);
  }
  // Preserve prior canonical effective-date, recording-date and ID precedence
  // across pages from disjoint ingredient batches.
  priceRows.sort((a,b)=>a.effective_from.localeCompare(b.effective_from)||
    a.recorded_at.localeCompare(b.recorded_at)||a.id.localeCompare(b.id));

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
):Promise<BusinessSnapshot & {ownerFeePlans:OwnerFeePlan[];
  ownerMonthlyPayrollExtrasCents:number|null;historicalPeriod:{
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
    .select("id,name,timezone,currency,payroll_tax_rate,payroll_tax_rate_status,payroll_tax_rate_source,target_operating_margin,target_operating_margin_status,target_ingredient_cost_rate,target_ingredient_cost_rate_status,owner_monthly_payroll_extras_cents")
    .eq("id",businessId).single();
  if(businessError||!business||!business.timezone)throw new Error("Historical café scope unavailable");
  const today=formatInTimeZone(new Date(),business.timezone,"yyyy-MM-dd");
  if(period.from>today)throw new Error("Historical period has no completed dates");
  period={...period,to:period.to>today?today:period.to};
  const first=period.from.slice(0,7)+"-01";
  const [firstYear,firstMonth]=first.slice(0,7).split("-").map(Number);
  const precedingMonthStart=(firstMonth===1?String(firstYear-1).padStart(4,"0")+"-12":String(firstYear).padStart(4,"0")+"-"+String(firstMonth-1).padStart(2,"0"))+"-01";
  const last=period.to.slice(0,7);
  const [year,month]=last.split("-").map(Number);
  const monthEnd=last+"-"+String(new Date(year,month,0).getDate()).padStart(2,"0");
  const [rollups,recurring,expenses,locations,itemSales]=await Promise.all([
    readDailyFactRows(supabase,businessId,period.from,period.to)
      .then(data=>({data,error:null}),(error:Error)=>({data:null,error})),
    snapshotPaged("historical_recurring_costs",(start,end)=>supabase.from("recurring_costs")
      .select("id,category_code,amount_cents,frequency,is_estimate,active_from,active_to,label,due_day,source",{count:"exact"})
      .eq("business_id",businessId).lte("active_from",monthEnd)
      .order("id",{ascending:true}).range(start,end),row=>row.id),
    snapshotPaged("historical_expenses",(start,end)=>supabase.from("expenses")
      .select("id,category_code,amount_cents,status,spent_on,recurring_cost_id,custom_label,vendor,source",{count:"exact"})
      .eq("business_id",businessId).gte("spent_on",precedingMonthStart).lte("spent_on",monthEnd)
      .order("id",{ascending:true}).range(start,end),row=>row.id),
    supabase.from("locations").select("open_hours")
      .eq("business_id",businessId).order("name",{ascending:true}).limit(1),
    readPeriodItemSales(supabase,businessId,period),
  ]);
  for(const result of [rollups,recurring,expenses,locations])
    if(result.error)throw result.error;
  // The same stable, exact full-row read as Home/Money, with historical date
  // scope. Never splice a differently sorted second page into a financial total.
  const allRollups=[...(rollups.data??[])];
  const allExpenses=expenses.data;
  const allRecurring=recurring.data;
  const recorded=allRollups.map(rowToDailyFacts);
  const sales=recorded.filter(d=>d.salesDataStatus!=="missing");
  const months:string[]=[];
  let cursor=first;
  while(cursor<=last+"-01"){
    months.push(cursor.slice(0,7));
    const [y,m]=cursor.split("-").map(Number);
    if(cursor.slice(0,7)===last)break;
    const nextYear=m===12?y+1:y,nextMonth=m===12?1:m+1;
    cursor=String(nextYear).padStart(4,"0")+"-"+String(nextMonth).padStart(2,"0")+"-01";
  }
  const monthlyAmounts:import("@/lib/calc").CategoryMonthlyAmount[]=[];
  const missingExpenseCategories:string[]=[];
  const estimatedExpenseCategories:string[]=[];
  const linesByMonth=new Map<string,RunningCostLine[]>();
  for(const key of months){
    const finalDay=key+"-"+String(new Date(Number(key.slice(0,4)),Number(key.slice(5,7)),0).getDate()).padStart(2,"0");
    const lines=runningCostLinesForMonth({expenses:allExpenses,recurring:allRecurring,from:key+"-01",
      to:finalDay,today,historical:key<today.slice(0,7),
      priorExpenses:allExpenses.filter(e=>e.spent_on<key+"-01")});
    linesByMonth.set(key,lines);
    for(const line of lines){
      const {categoryCode,isEstimate,isMissing}=line;
      monthlyAmounts.push(runningCostMonthlyAmount(line,key));
      if(isEstimate)estimatedExpenseCategories.push("expense:"+categoryCode+":"+key);
      if(isMissing||line.forecastOverlapUncertain)missingExpenseCategories.push("expense:"+categoryCode+":"+key);
    }
  }
  const monthKey=last;
  const runningCostLines=linesByMonth.get(monthKey)??[];
  const ownerFeePlans=await getOwnerConfirmedProcessingFeePlans(supabase,businessId);
  return {
    business:{id:business.id,name:business.name,timezone:business.timezone,
      currency:business.currency??null,
      payrollTaxRate:Number(business.payroll_tax_rate),
      payrollTaxRateStatus:business.payroll_tax_rate_status,
      payrollTaxRateSource:business.payroll_tax_rate_source,
      targetOperatingMargin:Number(business.target_operating_margin??.15),
      targetOperatingMarginStatus:business.target_operating_margin_status,
       targetIngredientCostRate:business.target_ingredient_cost_rate==null?null:Number(business.target_ingredient_cost_rate),
       targetIngredientCostRateStatus:business.target_ingredient_cost_rate_status??null,
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
    runningCostLines,recoveryOrder:runningCostLines.map(line=>line.categoryCode),
    menuItems:[],allCostProducts:[],periodItemSales:itemSales,breakEvenProductCosts:[],
    alerts:{count:0,leakingCents:0},staffShiftsToday:[],staffNowIso:new Date().toISOString(),
    historicalPeriod:{days:sales,recorded,monthlyAmounts,
      missingExpenseCategories,estimatedExpenseCategories},
    ownerFeePlans,
    ownerMonthlyPayrollExtrasCents:business.owner_monthly_payroll_extras_cents===null?
      null:Number(business.owner_monthly_payroll_extras_cents),
  };
}
