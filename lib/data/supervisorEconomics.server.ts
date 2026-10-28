import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {formatInTimeZone,fromZonedTime} from "date-fns-tz";
import {normalizeOpenHours,regularHoursStateForDate} from "@/lib/business/openHours";
import {dateOffset,calendarMonth} from "@/lib/calc/periods";
import {figure,addOwnerPayrollExtras,fixedCardFeeForCoveredSales,type Economics} from "@/lib/calc/supervisorEconomics";
import {payrollDayCoverage} from "@/lib/calc/payrollDayCoverage";
import {totalMonthlyRecurringCostsCents} from "@/lib/expenses/recurringMonthlyTotal";
import {getPricingInputs,type PricingItemInput} from "./getPricingInputs";
import {getOwnerConfirmedProcessingFeePlans,ownerConfirmedPlanForDate} from "@/lib/pos/processingFeeEstimate.server";
import {validateOwnerConfirmedProcessingFeePlan} from "@/lib/pos/processingFeeEstimate";
import {cardFeesForDays} from "@/lib/metrics/core/fees";
import {laborForPeriod,type LaborRecord} from "@/lib/metrics/core/labor";

export type SupervisorEconomicsRead={economics:Economics;items:PricingItemInput[];
 ownerMonthlyPayrollExtrasCents:number|null;ownerIngredientRate:number|null;
 staff:Array<{id:string;displayName:string;role:string|null;wageCents:number|null;weeklyHours:number|null}>};
/** All rows are filtered through the caller's authenticated RLS client, and the
 * server-established membership business ID. No service role or model-supplied ID. */
export async function readSupervisorEconomics(db:SupabaseClient,businessId:string,asOf:string):
 Promise<SupervisorEconomicsRead>{
 if(!businessId)throw new Error("Café scope required");
 const month=calendarMonth(asOf);
 const salesSince=dateOffset(asOf,-364);
 const business=await db.from("businesses").select("timezone,payroll_tax_rate,target_ingredient_cost_rate,target_ingredient_cost_rate_status,owner_monthly_payroll_extras_cents").eq("id",businessId).single();
 if(business.error)throw business.error;
 const [pricing,locations,recurring,rollups,employees,feePlans]=await Promise.all([
  getPricingInputs(db,businessId),
  db.from("locations").select("open_hours").eq("business_id",businessId).limit(1),
  db.from("recurring_costs").select("amount_cents,frequency,is_estimate,active_from,active_to")
   .eq("business_id",businessId).lte("active_from",asOf),
  db.from("daily_rollups").select("business_date,sales_data_status,net_sales_cents,ingredients_cents,card_fees_cents,card_fees_status,staff_wages_cents,staff_tax_cents,labor_wage_status,staff_tax_status,drinks_count,orders_count")
   .eq("business_id",businessId).gte("business_date",salesSince).lte("business_date",asOf).limit(500),
  db.from("employees").select("id,display_name,role,default_hourly_wage_cents").eq("business_id",businessId).eq("active",true).limit(500),
  getOwnerConfirmedProcessingFeePlans(db,businessId)
 ]);
 for(const response of [locations,recurring,rollups,employees])
  if(response.error)throw response.error;
 if((employees.data??[]).length>=500)throw new Error("Employee roster page truncated");
 if(!business.data?.timezone)throw new Error("Café timezone missing");
 const timezone=business.data.timezone;
 const hours=normalizeOpenHours(locations.data?.[0]?.open_hours);
 const open=(day:string)=>regularHoursStateForDate(hours,day)!=="closed";
 const dayList:string[]=[];
 for(let day=month.from;day<=month.to;day=dateOffset(day,1))if(open(day))dayList.push(day);
 const salesDays=(rollups.data??[]).filter(row=>row.sales_data_status==="actual")
  .map(row=>row.business_date).sort();
 const latest=salesDays.at(-1);
 const first=latest?salesDays.find(day=>day>=dateOffset(latest,-29)):undefined;
 const coveredDates=new Set(salesDays.filter(day=>first&&day>=first&&day<=latest));
 const laborWindow=[...coveredDates].filter(open);
 const timecards=await db.from("timecards")
  .select("employee_id,clock_in,clock_out,hourly_wage_cents,source_type")
  .eq("business_id",businessId)
  .gte("clock_in",fromZonedTime((first??month.from)+"T00:00:00",timezone).toISOString())
  .lte("clock_in",fromZonedTime((latest??asOf)+"T23:59:59",timezone).toISOString()).limit(2001);
 if(timecards.error)throw timecards.error;
 if((timecards.data??[]).length>2000)throw new Error("Labor timecard page truncated");
 const payEvidence=payrollDayCoverage(
  (timecards.data??[]).filter(row=>row.source_type!=="owner_schedule").map(row=>({
   businessDate:formatInTimeZone(new Date(row.clock_in),timezone,"yyyy-MM-dd"),
   clockOut:row.clock_out,hourlyWageCents:row.hourly_wage_cents===null?null:Number(row.hourly_wage_cents)
  })),
  (rollups.data??[]).map(row=>({
   businessDate:row.business_date,
   staffWagesCents:row.staff_wages_cents===null?null:Number(row.staff_wages_cents),
   staffTaxCents:row.staff_tax_cents===null?null:Number(row.staff_tax_cents),
   laborWageStatus:row.labor_wage_status,taxStatus:row.staff_tax_status
  }))
 );
 const recorded=payEvidence.coveredDates;
 const laborDays=laborWindow.filter(day=>recorded.has(day));
 const laborMissing=laborWindow.filter(day=>!recorded.has(day));
 const laborRows:LaborRecord[]=(rollups.data??[]).filter(row=>recorded.has(row.business_date))
  .map(row=>({date:row.business_date,
   wagesCents:row.staff_wages_cents===null?null:Number(row.staff_wages_cents),
   staffTaxCents:row.staff_tax_cents===null?null:Number(row.staff_tax_cents),
   laborWageStatus:row.labor_wage_status,
   staffTaxStatus:row.staff_tax_status}));
 const ownerMonthlyPayrollExtrasCents=business.data?.owner_monthly_payroll_extras_cents==null?
  null:Number(business.data.owner_monthly_payroll_extras_cents);
 // Same core as Home/Money: project from every usable payroll day; do not
 // withhold evidence simply because there are fewer than seven covered days.
 const laborEvidence=laborForPeriod(dayList.map(date=>({date})),laborRows,null,
  ownerMonthlyPayrollExtrasCents===null?null:{monthlyCents:ownerMonthlyPayrollExtrasCents,
   from:month.from,to:month.to});
 const payroll=figure(laborEvidence.projectedMonthlyLaborCents,
  laborEvidence.basis==="recorded"?"actual":"estimate",
  laborEvidence.coveredDays<laborEvidence.totalDays?"laborPartialCoverage":
    ownerMonthlyPayrollExtrasCents!==null?"laborOwnerExtras":
    laborEvidence.notes.includes("laborEstimated")?"laborEstimated":"laborRecorded",
  laborMissing,{covered:laborDays.length,total:laborWindow.length});
 const active=(recurring.data??[]).filter(row=>!row.active_to||row.active_to>=asOf);
 const billTotal=active.length?totalMonthlyRecurringCostsCents(active.map(row=>({
  amountCents:Number(row.amount_cents),frequency:row.frequency as "monthly"|"weekly"|"quarterly"|"yearly"
 }))):null;
 const billStatus=active.some(row=>row.is_estimate)?"estimate":"actual";
 // The Menu/Money basis replaces recurring schedule amounts by actual
 // category expenses; never add a receipt on top of its scheduled bill.
 const running=pricing.menuPriceBasis;
 const knownBills=running.runningKnownCents>0?running.runningKnownCents:billTotal;
 const billsPartial=running.missingRunningCategories.length>0;
 const monthlyBills=figure(running.monthlyRunningCents??knownBills,
  !billsPartial&&running.runningStatus==="recorded"?"actual":billStatus==="estimate"?"estimate":"estimate",
  billsPartial?"billsPartial":running.monthlyRunningCents===null?"billsKnownRecurring":"billsRecorded",
  [],{missing:running.missingRunningCategories.join(", ")});
 const revenue=pricing.business.monthlyRevenueCents;
 const soldCount=pricing.items.reduce((sum,item)=>sum+Math.max(0,item.unitsSoldInWindow),0);
 const recipesReady=pricing.business.productCostsStatus!=="missing"&&revenue>0&&soldCount>0;
 const recipeRate=recipesReady?pricing.business.monthlyVariableProductCostCents/revenue:null;
 const savedRate=business.data?.target_ingredient_cost_rate==null?null:Number(business.data.target_ingredient_cost_rate);
 const ingredientRate=recipeRate??savedRate;
 const ingredientStatus=recipeRate!==null?"actual":savedRate!==null?
  (business.data?.target_ingredient_cost_rate_status==="owner"||
    business.data?.target_ingredient_cost_rate_status==="confirmed"?"owner":"estimate"):"missing";
 const hasCoveredSales=(rollups.data??[]).some(row=>row.sales_data_status!=="missing"&&
  Number(row.net_sales_cents)>0);
 const allFeeDays=(rollups.data??[]).map(row=>({
  date:row.business_date,netSalesCents:Number(row.net_sales_cents??0),
  cardFeesCents:row.card_fees_cents===null?null:Number(row.card_fees_cents),
  cardFeesStatus:row.card_fees_status,ordersCount:Number(row.orders_count??0),
  salesDataStatus:row.sales_data_status,
 }));
 const coveredFeeDays=allFeeDays.filter(day=>day.salesDataStatus!=="missing");
 const fees=cardFeesForDays(coveredFeeDays,feePlans);
 const feeSalesCents=coveredFeeDays.reduce((sum,day)=>sum+day.netSalesCents,0);
 const feeRate=feeSalesCents>0?fees.amountCents/feeSalesCents:null;
 const feeStatus=feeRate===null?"missing":fees.basis==="actual"?"actual":"estimate";
 const salesDates=(rollups.data??[]).filter(row=>coveredDates.has(row.business_date));
 const totalDrinks=salesDates.reduce((sum,row)=>sum+Math.max(0,Number(row.drinks_count??0)),0);
 const totalOrders=salesDates.reduce((sum,row)=>sum+Math.max(0,Number(row.orders_count??0)),0);
 const plan=ownerConfirmedPlanForDate(feePlans,asOf);
 // Owner-confirmed plan overrides the observed effective rate only when the
 // café has actual covered drinks and orders for fixed-fee allocation.
 const feePlan=plan&&validateOwnerConfirmedProcessingFeePlan(plan)===null?
  fixedCardFeeForCoveredSales(plan,totalDrinks,totalOrders):undefined;
 const observedRevenueCents=salesDates.reduce((sum,row)=>sum+Number(row.net_sales_cents??0),0);
 const salesObserved=salesDates.length>0;
 const salesOpenDays=salesDates.filter(row=>open(row.business_date)).length;
 // Revenue, cups and average selling price all use THE SAME café-local
 // covered dates. Never divide a 90-day Menu revenue projection by a
 // current-month unit projection (which invents an average drink price).
 const monthlyRevenueCents=salesObserved&&salesOpenDays>0?
  Math.round(observedRevenueCents*dayList.length/salesOpenDays):null;
 const monthlyUnits=totalDrinks>0&&salesOpenDays>0?
  Math.round(totalDrinks*dayList.length/salesOpenDays):null;
 const averagePriceCents=totalDrinks>0&&observedRevenueCents>0?
  Math.round(observedRevenueCents/totalDrinks):null;
 return {economics:{
  monthlyBills,monthlyStaff:payroll,
  knownMonthlyLaborExtrasCents:ownerMonthlyPayrollExtrasCents,
  monthlyRevenue:figure(monthlyRevenueCents,"estimate",
    "monthlyRevenueCovered"),
  ingredientRate,feeRate,ingredientStatus,feeStatus,averagePriceCents,monthlyUnits,feePlan,
  ownerFeePlans:feePlans,
  daysInMonth:dayList.length||Number(month.to.slice(-2)),
  laborCoveredDays:laborDays.length,laborWindowDays:laborWindow.length,
  salesCoverage:first&&latest?{from:first,to:latest,openDays:salesOpenDays}:undefined,
  targetMargin:pricing.business.targetOperatingMargin??.15,missingDays:laborMissing,
  payrollTaxRate:Number(business.data.payroll_tax_rate??.12),
  missingBillCategories:running.missingRunningCategories,
  asOfDate:asOf,
  observedDays:(rollups.data??[]).filter(row=>row.sales_data_status!=="missing")
   .map(row=>({date:row.business_date,netSalesCents:Number(row.net_sales_cents??0),
     ingredientsCents:Number(row.ingredients_cents??0),
     cardFeesCents:Number(row.card_fees_cents??0),
      cardFeesStatus:row.card_fees_status??"missing",
      ordersCount:Number(row.orders_count??0),drinksCount:Number(row.drinks_count??0)})),
 },items:pricing.items,ownerMonthlyPayrollExtrasCents,ownerIngredientRate:savedRate,
 staff:(employees.data??[]).map(person=>{
  const worked=(timecards.data??[]).filter(card=>card.source_type!=="owner_schedule"&&
   card.employee_id===person.id&&card.clock_out);
  const hours=worked.reduce((sum,card)=>sum+Math.max(0,(
   Date.parse(card.clock_out!)-Date.parse(card.clock_in))/3600000),0);
  return {id:person.id,displayName:person.display_name,role:person.role,
   wageCents:person.default_hourly_wage_cents==null?null:Number(person.default_hourly_wage_cents),
   weeklyHours:worked.length?hours*7/Math.max(1,laborWindow.length):null};
 })};
}
