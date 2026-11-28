import "server-only";
import {readDailyFactRows} from "./dailyFacts.server";
import { formatInTimeZone } from "date-fns-tz";
import { buildDayWindows } from "@/lib/calc";
import { runningCostMonthlyAmount, rowToDailyFacts } from "./runningCostCatalog";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessSnapshot, MenuItemSnapshot, RunningCostLine, StaffShift } from "./types";
import { normalizeOpenHours } from "@/lib/business/openHours";
import { readPeriodItemSales } from "./periodItemSales.server";
import {readProductCosts} from "./productCosts.server";
import {readFinancialPeriods} from "./financialPeriods.server";
import {getOwnerConfirmedProcessingFeePlans} from "@/lib/pos/processingFeeEstimate.server";
import type {OwnerFeePlan} from "@/lib/metrics/core/fees";
import {shiftCafeDate} from "@/lib/metrics/core/clock";
import {hasSalesCoverage} from "@/lib/calc/dayWindows";
import {timeReader} from "@/lib/perf/timeReader.server";
import {readCompletePaged} from "./completePages";
import {readRunningCostLines} from "./runningCostLines.server";
import type {MenuCatalogRow} from "./menuCatalog.server";

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
  const [rollupResult,currentCostLines,priorCostLines,recoveryOrderResult,
    allMenuItemSnapshots,periodItemSales,staffShiftsToday,alertsRead,ownerFeePlans,financialPeriods]=
    await Promise.all([
      timeReader("Snapshot","dailyFacts",()=>readDailyFactRows(supabase,businessId,prevMonthStart,todayDateStr))
        .then(data=>({data,error:null}),(error:Error)=>({data:null,error})),
      timeReader("Snapshot","runningCosts",()=>readRunningCostLines(supabase,businessId,monthStart,todayDateStr,Boolean(asOfDate))),
      timeReader("Snapshot","priorRunningCosts",()=>readRunningCostLines(supabase,businessId,prevMonthStart,prevMonthEnd,Boolean(asOfDate))),
      timeReader("Snapshot","recoveryOrder",async()=>supabase.from("recovery_order")
        .select("bucket_code, position").eq("business_id",businessId).order("position",{ascending:true})),
      timeReader("Snapshot","menuCosts",()=>getMenuItemSnapshots(supabase,businessId,todayDateStr,asOfDate)),
      timeReader("Snapshot","periodItemSales",()=>readPeriodItemSales(supabase,businessId,{from:periodFrom,to:todayDateStr})),
      timeReader("Snapshot","staffShifts",()=>getStaffShiftsToday(supabase,businessId,todayDateStr)),
      timeReader("Snapshot","alerts",()=>snapshotPaged("alerts",
        (start,end)=>supabase.from("alerts").select("id,impact_cents",{count:"exact"})
         .eq("business_id",businessId).in("status",["new","seen"])
         .order("id",{ascending:true}).range(start,end),
        row=>row.id)),
      timeReader("Snapshot","feePlans",()=>getOwnerConfirmedProcessingFeePlans(supabase,businessId)),
      timeReader("Snapshot","financialPeriods",()=>readFinancialPeriods(supabase,businessId,asOfDate)),
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
  if (recoveryOrderResult.error) throw recoveryOrderResult.error;
  const recoveryOrder=(recoveryOrderResult.data??[]).map(r=>r.bucket_code);
  // Order is presentation only; SQL owns the amounts and evidence.
  const ordered=(rows:RunningCostLine[])=>[...rows].sort((a,b)=>{
    const rank=(code:string)=>recoveryOrder.includes(code)?recoveryOrder.indexOf(code):recoveryOrder.length;
    return rank(a.categoryCode)-rank(b.categoryCode);
  });
  const runningCostLines=ordered(currentCostLines);
  const previousRunningCostLines=ordered(priorCostLines);
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
    financialPeriods,
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
    staffNowIso: staffShiftsToday[0]?.canonicalCostAsOf ?? new Date().toISOString(),
    staffCostTodayCents:staffShiftsToday.length===0?0:staffShiftsToday[0].canonicalDayLoadedCostCents,
    ownerFeePlans,
    ownerMonthlyPayrollExtrasCents:businessRow.owner_monthly_payroll_extras_cents===null?
      null:Number(businessRow.owner_monthly_payroll_extras_cents),
  } as BusinessSnapshot;
}

/** All of today's timecards (business-timezone calendar day), joined to the employee's name/role. */
async function getStaffShiftsToday(
  supabase: SupabaseClient,
  businessId: string,
  todayDateStr: string,
): Promise<StaffShift[]> {

  const {data}=await snapshotPaged("cv_staff_clock_entries",
    (start,end)=>supabase.from("cv_staff_clock_entries")
     .select("id,employee_id,schedule_id,source_type,source_provider,clock_in,clock_out,hourly_wage_cents,breaks,provider_regular_hours,provider_overtime_hours,employee_name,employee_role,as_of,loaded_cost_cents,loaded_hourly_cents,day_loaded_cost_cents",{count:"exact"})
     .eq("business_id",businessId).eq("business_date",todayDateStr)
     .order("clock_in",{ascending:true}).order("id",{ascending:true})
     .range(start,end),row=>row.id);
  // Preserve every recorded timecard for earned wages, including staff who were
  // deactivated later today and imports not yet linked to a roster member.
  // Current-roster filtering belongs ONLY in buildStaffViewModel.onShift.
  return (data ?? []).map((row) => {
    return {
      employeeId: row.employee_id ?? row.id,
      name: row.employee_name ?? "Staff",
      role: row.employee_role ?? null,
      canonicalLoadedCostCents:row.loaded_cost_cents==null?null:Number(row.loaded_cost_cents),
      canonicalLoadedHourlyCents:row.loaded_hourly_cents==null?null:Number(row.loaded_hourly_cents),
      canonicalDayLoadedCostCents:row.day_loaded_cost_cents==null?null:Number(row.day_loaded_cost_cents),
      canonicalCostAsOf:row.as_of,
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
  asOfDate?:string,
): Promise<MenuItemSnapshot[]> {
  const {data:items}=await snapshotPaged("menu_items",async(start,end)=>{
    const page=await supabase.rpc("menu_catalog_for",{p_business_id:businessId},{count:"exact"})
     .select("id,name,price_cents,prep_seconds,category,is_active")
     .order("id",{ascending:true}).range(start,end);
    return {...page,data:page.data as Pick<MenuCatalogRow,
      "id"|"name"|"price_cents"|"prep_seconds"|"category"|"is_active">[]|null};
  },row=>row.id);
  if (!items || items.length === 0) return [];

  const itemIds = items.map((i) => i.id);

  // Source IDs remain scoped to this café and batch sizes bound URL length.
  // Page each batch by immutable source identity; any incomplete source fails
  // closed, never as a fabricated zero quantity or missing recipe ingredient.
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
    (typeof row.total_quantity!=="number"&&(typeof row.total_quantity!=="string"||!row.total_quantity.trim()))||
    !Number.isFinite(Number(row.total_quantity))||Number(row.total_quantity)<0||
    Number(row.total_quantity)>Number.MAX_SAFE_INTEGER))
    throw new Error("snapshot_product_sales_mapping_unverified");
  const costs=await readProductCosts(supabase,businessId,itemIds,asOfDate);
  const quantityByItem=new Map(quantitySoldRows.map(r=>[r.menu_item_id,Number(r.total_quantity)]));
  return items.map(item=>{
    const cost=costs.get(item.id)!;
    return {
      id:item.id,name:item.name,priceCents:item.price_cents??0,prepSeconds:item.prep_seconds,
      category:(item.category==="food"?"food":"drink") as "drink"|"food",active:item.is_active,
      ingredientsCentsToday:cost.costCents??0,hasRecipe:cost.recipe.length>0||cost.source==="combo",
      costStatus:cost.status,costSource:cost.source,recipeCostCents:cost.recipeCostCents,
      recipeCostStatus:cost.recipeStatus,ownerTotalCostCents:cost.ownerTotalCostCents,
      costDifferenceCents:cost.differenceCents,
      costQuality:cost.status!=="READY"?null:cost.estimated?"estimated":"actual",
      quantitySoldLast28Days:quantityByItem.get(item.id)??0,
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
  const last=period.to.slice(0,7);
  const [year,month]=last.split("-").map(Number);
  const [rollups,locations,itemSales]=await Promise.all([
    readDailyFactRows(supabase,businessId,period.from,period.to)
      .then(data=>({data,error:null}),(error:Error)=>({data:null,error})),
    supabase.from("locations").select("open_hours")
      .eq("business_id",businessId).order("name",{ascending:true}).limit(1),
    readPeriodItemSales(supabase,businessId,period),
  ]);
  for(const result of [rollups,locations])
    if(result.error)throw result.error;
  // The same stable, exact full-row read as Home/Money, with historical date
  // scope. Never splice a differently sorted second page into a financial total.
  const allRollups=[...(rollups.data??[])];
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
    const lines=await readRunningCostLines(supabase,businessId,key+"-01",today<finalDay?today:finalDay);
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
