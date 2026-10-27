import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {formatInTimeZone,fromZonedTime} from "date-fns-tz";
import {normalizeOpenHours,regularHoursStateForDate} from "@/lib/business/openHours";
import {dateOffset,calendarMonth} from "@/lib/calc/periods";
import {figure,addOwnerPayrollExtras,type Economics} from "@/lib/calc/supervisorEconomics";
import {payrollDayCoverage} from "@/lib/calc/payrollDayCoverage";
import {totalMonthlyRecurringCostsCents} from "@/lib/expenses/recurringMonthlyTotal";
import {getPricingInputs,type PricingItemInput} from "./getPricingInputs";

export type SupervisorEconomicsRead={economics:Economics;items:PricingItemInput[];
 ownerMonthlyPayrollExtrasCents:number|null;ownerIngredientRate:number|null;
 staff:Array<{id:string;displayName:string;role:string|null;wageCents:number|null;weeklyHours:number|null}>};
/** All rows are filtered through the caller's authenticated RLS client, and the
 * server-established membership business ID. No service role or model-supplied ID. */
export async function readSupervisorEconomics(db:SupabaseClient,businessId:string,asOf:string):
 Promise<SupervisorEconomicsRead>{
 if(!businessId)throw new Error("Café scope required");
 const month=calendarMonth(asOf);
 const business=await db.from("businesses").select("timezone,payroll_tax_rate,target_ingredient_cost_rate,target_ingredient_cost_rate_status,owner_monthly_payroll_extras_cents").eq("id",businessId).single();
 if(business.error)throw business.error;
 const [pricing,locations,recurring,rollups,connections,timecards,employees]=await Promise.all([
  getPricingInputs(db,businessId),
  db.from("locations").select("open_hours").eq("business_id",businessId).limit(1),
  db.from("recurring_costs").select("amount_cents,frequency,is_estimate,active_from,active_to")
   .eq("business_id",businessId).lte("active_from",asOf),
  db.from("daily_rollups").select("business_date,sales_data_status,net_sales_cents,staff_wages_cents,staff_tax_cents,labor_wage_status,staff_tax_status,drinks_count")
   .eq("business_id",businessId).gte("business_date",month.from).lte("business_date",asOf).limit(500),
  db.from("pos_connections").select("provider").eq("business_id",businessId).eq("status","active"),
  db.from("timecards").select("employee_id,clock_in,clock_out,hourly_wage_cents,source_type")
   .eq("business_id",businessId).gte("clock_in",fromZonedTime(month.from+"T00:00:00",
    business.data?.timezone??"America/Los_Angeles").toISOString())
   .lte("clock_in",fromZonedTime(asOf+"T23:59:59",
    business.data?.timezone??"America/Los_Angeles").toISOString()).limit(2001),
  db.from("employees").select("id,display_name,role,default_hourly_wage_cents").eq("business_id",businessId).eq("active",true).limit(500)
 ]);
 for(const response of [locations,recurring,rollups,connections,timecards,employees])
  if(response.error)throw response.error;
 if((timecards.data??[]).length>2000)throw new Error("Labor timecard page truncated");
 if((employees.data??[]).length>=500)throw new Error("Employee roster page truncated");
 const timezone=business.data?.timezone??"America/Los_Angeles";
 const hours=normalizeOpenHours(locations.data?.[0]?.open_hours);
 const open=(day:string)=>regularHoursStateForDate(hours,day)!=="closed";
 const todayActual=(rollups.data??[]).some(row=>row.business_date===asOf&&row.sales_data_status==="actual");
 const through=todayActual?asOf:dateOffset(asOf,-1);
 const dayList:string[]=[];
 for(let day=month.from;day<=month.to;day=dateOffset(day,1))if(open(day))dayList.push(day);
 const elapsed=dayList.filter(day=>day<=through);
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
 const laborDays=elapsed.filter(day=>recorded.has(day));
 const laborMissing=elapsed.filter(day=>!recorded.has(day));
 // Match the numerator to the same elapsed, open, labor-covered dates used by the projection denominator.
 const payrollRows=(rollups.data??[]).filter(row=>laborDays.includes(row.business_date));
 const wages=payrollRows.reduce((sum,row)=>sum+Number(row.staff_wages_cents)+Number(row.staff_tax_cents),0);
 const estimatedTax=payrollRows.some(row=>payEvidence.taxEstimatedDays.has(row.business_date));
 const projectedLabor=laborDays.length?Math.round(wages*dayList.length/laborDays.length):null;
 const ownerMonthlyPayrollExtrasCents=business.data?.owner_monthly_payroll_extras_cents===null||
  business.data?.owner_monthly_payroll_extras_cents===undefined?null:Number(business.data.owner_monthly_payroll_extras_cents);
 const monthlyTotal=addOwnerPayrollExtras(projectedLabor,ownerMonthlyPayrollExtrasCents);
 const payroll=figure(monthlyTotal,
  ownerMonthlyPayrollExtrasCents!==null||laborMissing.length||estimatedTax?"estimate":"actual",
  laborMissing.length?"Clocked wages incomplete; "+laborMissing.length+" labor days missing; owner extras do not replace wages":
  ownerMonthlyPayrollExtrasCents!==null?"Projected clocked wages plus owner-reported monthly extras (once)":
  estimatedTax?"Employer payroll tax estimated":"Clocked wages plus payroll tax",laborMissing);
 const active=(recurring.data??[]).filter(row=>!row.active_to||row.active_to>=asOf);
 const billTotal=active.length?totalMonthlyRecurringCostsCents(active.map(row=>({
  amountCents:Number(row.amount_cents),frequency:row.frequency as "monthly"|"weekly"|"quarterly"|"yearly"
 }))):null;
 const billStatus=active.some(row=>row.is_estimate)?"estimate":"actual";
 // The Menu/Money basis replaces recurring schedule amounts by actual
 // category expenses; never add a receipt on top of its scheduled bill.
 const running=pricing.menuPriceBasis;
 const knownBills=running.runningKnownCents>0?running.runningKnownCents:billTotal;
 const monthlyBills=figure(running.monthlyRunningCents??knownBills,
  running.runningStatus==="recorded"?"actual":billStatus==="estimate"?"estimate":"estimate",
  running.monthlyRunningCents===null?"Known recurring bills only; additional categories may be missing":
   "Saved running expenses with actual-by-category replacement");
 const revenue=pricing.business.monthlyRevenueCents;
 const soldCount=pricing.items.reduce((sum,item)=>sum+Math.max(0,item.unitsSoldInWindow),0);
 const recipesReady=pricing.business.productCostsStatus!=="missing"&&revenue>0&&soldCount>0;
 const recipeRate=recipesReady?pricing.business.monthlyVariableProductCostCents/revenue:null;
 const savedRate=business.data?.target_ingredient_cost_rate==null?null:Number(business.data.target_ingredient_cost_rate);
 const ingredientRate=recipeRate??savedRate;
 const ingredientStatus=recipeRate!==null?"actual":savedRate!==null?
  (business.data?.target_ingredient_cost_rate_status==="owner"||
    business.data?.target_ingredient_cost_rate_status==="confirmed"?"owner":"estimate"):"missing";
 const hasToast=(connections.data??[]).some(row=>row.provider==="toast");
 const feeBasis=pricing.menuPriceBasis;
 const feeRecorded=feeBasis.feeStatus!=="missing"&&
  (feeBasis.processingFeeDenominatorCents??0)>0;
 const feeRate=feeRecorded?Number(feeBasis.processingFeeNumeratorCents)/
   Number(feeBasis.processingFeeDenominatorCents):hasToast?.029:null;
 const feeStatus=feeRecorded?feeBasis.feeStatus==="actual"?"actual":"estimate":
  hasToast?"estimate":"missing";
 const salesDates=(rollups.data??[]).filter(row=>row.sales_data_status==="actual");
 const totalDrinks=salesDates.reduce((sum,row)=>sum+Math.max(0,Number(row.drinks_count??0)),0);
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
    "Current month's covered sales projected across open days; not recorded month-end revenue"),
  ingredientRate,feeRate,ingredientStatus,feeStatus,averagePriceCents,monthlyUnits,
  daysInMonth:dayList.length||Number(month.to.slice(-2)),
  targetMargin:pricing.business.targetOperatingMargin??.15,missingDays:laborMissing,
  payrollTaxRate:Number(business.data.payroll_tax_rate??.12),
  missingBillCategories:running.missingRunningCategories,
 },items:pricing.items,ownerMonthlyPayrollExtrasCents,ownerIngredientRate:savedRate,
 staff:(employees.data??[]).map(person=>{
  const worked=(timecards.data??[]).filter(card=>card.source_type!=="owner_schedule"&&
   card.employee_id===person.id&&card.clock_out);
  const hours=worked.reduce((sum,card)=>sum+Math.max(0,(
   Date.parse(card.clock_out!)-Date.parse(card.clock_in))/3600000),0);
  return {id:person.id,displayName:person.display_name,role:person.role,
   wageCents:person.default_hourly_wage_cents==null?null:Number(person.default_hourly_wage_cents),
   weeklyHours:worked.length?hours*7/Math.max(1,elapsed.length):null};
 })};
}
