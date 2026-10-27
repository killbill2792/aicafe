import {calculateBreakEvenSales} from "./breakEvenSales";
import {baselinePriceCents} from "./pricingBaseline";
import {applyRounding} from "./pricingRounding";
import {COFFEE_SHOP_PROFILE} from "@/lib/pricing/profiles";
export type FigureStatus="actual"|"estimate"|"owner"|"missing";
export type Figure={valueCents:number|null;status:FigureStatus;reason:string;missingDays:string[]};
export const figure=(valueCents:number|null,status:FigureStatus,reason:string,missingDays:string[]=[]):Figure=>({
 valueCents,status:valueCents===null?"missing":status,reason,missingDays
});
/** Owner costs are EXTRAS, never a substitute for known/clocked payroll.
 * Without a clocked-labor basis, even saved extras cannot certify total payroll. */
export function addOwnerPayrollExtras(clockedMonthlyCents:number|null,extrasCents:number|null):number|null{
 if(clockedMonthlyCents===null)return null;
 return clockedMonthlyCents+(extrasCents??0);
}
export type Economics={
 monthlyBills:Figure;monthlyStaff:Figure;monthlyRevenue:Figure;
 /** Saved extras remain a known-cost floor when imported clocked labor is missing. */
 knownMonthlyLaborExtrasCents?:number|null;
 ingredientRate:number|null;feeRate:number|null;
 ingredientStatus:FigureStatus;feeStatus:FigureStatus;
 averagePriceCents:number|null;monthlyUnits:number|null;daysInMonth:number;
 targetMargin:number;missingDays:string[];payrollTaxRate?:number;
 /** Expected operating categories without current actual or recurring basis. */
 missingBillCategories?:string[];
};
/** Money, Plan and chat must use the same monthly contribution math.
 * Missing variable costs never silently become zero; known fixed costs survive partial payroll. */
export function unifiedBreakEven(input:Economics){
 const fixed=[input.monthlyBills,input.monthlyStaff].filter(f=>f.valueCents!==null);
 const extrasFloor=input.monthlyStaff.valueCents===null?
  (input.knownMonthlyLaborExtrasCents??0):0;
 const fixedKnown=fixed.reduce((sum,f)=>sum+f.valueCents!,0)+extrasFloor;
 const missing=[...(input.monthlyBills.valueCents===null?["monthlyBills"]:[]),
   ...(input.missingBillCategories??[]).map(category=>"monthlyBill:"+category),
   ...(input.monthlyStaff.valueCents===null?["monthlyLabor"]:[]),
   ...(input.ingredientRate===null?["ingredientRate"]:[]),
   ...(input.feeRate===null?["processingFeeRate"]:[])];
 const rateKnown=input.ingredientRate!==null&&input.feeRate!==null;
 const effectiveIngredientRate=input.ingredientRate??0;
 const effectiveFeeRate=input.feeRate??0;
 const computed=calculateBreakEvenSales({
  monthlyBillsCents:input.monthlyBills.valueCents??0,
  monthlyStaffCents:input.monthlyStaff.valueCents??extrasFloor,
  observedSalesCents:100_000_000,
  observedIngredientCents:Math.round(100_000_000*effectiveIngredientRate),
  observedProcessingFeesCents:Math.round(100_000_000*effectiveFeeRate)
 });
 const completeFixed=input.monthlyBills.valueCents!==null&&input.monthlyStaff.valueCents!==null;
 const knownCostBreakEvenFloorCents=(fixed.length>0||extrasFloor>0)&&rateKnown&&
  computed.kind==="ready"?computed.breakEvenSalesCents:null;
 const monthlyCents=completeFixed&&rateKnown&&!(input.missingBillCategories?.length)&&
  computed.kind==="ready"?computed.breakEvenSalesCents:null;
 const drinksPerDay=monthlyCents!==null&&input.averagePriceCents!==null&&input.averagePriceCents>0
  ?Math.ceil(monthlyCents/input.averagePriceCents/input.daysInMonth):null;
 const status:FigureStatus=missing.length||fixed.some(f=>f.status!=="actual")||
  input.ingredientStatus!=="actual"||input.feeStatus!=="actual"?"estimate":"actual";
 const reason=missing.length?"Known inputs only; missing: "+missing.join(", "):
  input.monthlyStaff.missingDays.length?"estimate: "+input.monthlyStaff.missingDays.length+" labor days missing":
  status==="actual"?"Recorded costs and sales":"Includes estimates or owner-entered figures";
 return {monthlyBreakEven:figure(monthlyCents,status,reason,input.missingDays),
  drinksPerDay,knownCostBreakEvenFloorCents,monthlyFixedKnownCents:fixedKnown,
  monthlyBills:input.monthlyBills,monthlyStaff:input.monthlyStaff,
  ingredientRate:input.ingredientRate,feeRate:input.feeRate,
  status,reason,missing};
}
export function recommendFullCostPrice(input:{
 ingredientCents:number;packagingCents:number|null;laborCents:number|null;
 overheadCents:number|null;units:number|null;feeRate:number|null;targetMargin:number;
}){
 const valid=(n:number|null)=>n!==null&&Number.isFinite(n)&&n>=0;
 const laborPerUnit=input.units&&input.units>0&&valid(input.laborCents)
  ?input.laborCents!/input.units:null;
 const overheadPerUnit=input.units&&input.units>0&&valid(input.overheadCents)
  ?input.overheadCents!/input.units:null;
 const fee=input.feeRate;
 const missing=[...(input.packagingCents===null?["packagingCents"]:[]),
  ...(laborPerUnit===null?["laborPerUnit"]:[]),
  ...(overheadPerUnit===null?["overheadPerUnit"]:[]),
  ...(fee===null?["processingFeeRate"]:[])];
 if((fee!==null&&(!Number.isFinite(fee)||fee<0||fee>=1))||
  !Number.isFinite(input.targetMargin)||input.targetMargin<0||
  (fee!==null&&fee+input.targetMargin>=1)){
  return {recommendedPriceCents:null,breakEvenCents:null,fullCostCents:null,
   knownCostFloorCents:null,knownCostFloorLabel:"floor, not a recommendation",
   missing:["invalidContributionMargin"]};
 }
 // Known-only costs are a LOWER bound. An unknown fee may be omitted only
 // when computing a floor, never when recommending a selling price.
 const knownCost=input.ingredientCents+(input.packagingCents??0)+
  (laborPerUnit??0)+(overheadPerUnit??0);
 if(missing.length)return {
  recommendedPriceCents:null,breakEvenCents:null,fullCostCents:null,
  knownCostFloorCents:Math.ceil(knownCost/(1-(fee??0))),
  knownCostFloorLabel:"floor, not a recommendation",missing,
 };
 // Preserve the original results when all inputs are known.
 const fractionalFullCost=input.ingredientCents+input.packagingCents!+
  laborPerUnit!+overheadPerUnit!;
 const fullCostCents=Math.round(fractionalFullCost);
 const breakEvenCents=Math.ceil(fractionalFullCost/(1-fee!));
 const targetPrice=fractionalFullCost/(1-fee!-input.targetMargin);
 const benchmark=baselinePriceCents(input.ingredientCents,COFFEE_SHOP_PROFILE.targetProductCostPercent);
 const {roundingRule}=COFFEE_SHOP_PROFILE;
 const increment=roundingRule.incrementCents;
 const recommendedPriceCents=Math.max(increment,
  applyRounding(Math.max(targetPrice,benchmark),roundingRule),
  Math.ceil(breakEvenCents/increment)*increment);
 return {recommendedPriceCents,breakEvenCents,fullCostCents,
  knownCostFloorCents:null,knownCostFloorLabel:"floor, not a recommendation",missing};
}
export type ScenarioDelta=
 |{kind:"bill";monthlyChangeCents:number}
 |{kind:"price";itemId:string;oldPriceCents:number;newPriceCents:number;weeklyUnits:number;unitCostCents:number|null}
 |{kind:"item_cost";itemId:string;oldCostCents:number;newCostCents:number;weeklyUnits:number;currentPriceCents:number}
 |{kind:"shift";hoursChange:number;wageCents:number;payrollTaxRate:number;shiftsPerWeek:number}
 |{kind:"wage";weeklyHours:number;oldWageCents:number;newWageCents:number;payrollTaxRate:number}
 |{kind:"drinks";changePercent:number}
 |{kind:"margin";targetMargin:number};
export function simulateEconomics(input:Economics,delta:ScenarioDelta){
 const before=unifiedBreakEven(input);
 const afterInput:Economics={...input};
 const weeklyFactor=input.daysInMonth/7; // 7 calendar days per week, same calendar-month length as Money
 let profitChangeCents:number|null=0,weeklyChangeCents:number|null=0;
 let itemMarginBeforeCents:number|null=null,itemMarginAfterCents:number|null=null;
 let targetMargin=input.targetMargin;
 if(delta.kind==="bill"){
  afterInput.monthlyBills=figure(input.monthlyBills.valueCents===null?null:
    Math.max(0,input.monthlyBills.valueCents+delta.monthlyChangeCents),
   "estimate","Scenario adjustment",input.monthlyBills.missingDays);
  profitChangeCents=-delta.monthlyChangeCents;
 }else if(delta.kind==="price"||delta.kind==="item_cost"){
  if(delta.kind==="price"){
   // Unknown processing fees cannot be treated as a zero-percent fee.
   weeklyChangeCents=input.feeRate===null?null:
    Math.round((delta.newPriceCents-delta.oldPriceCents)*delta.weeklyUnits*(1-input.feeRate));
   itemMarginBeforeCents=delta.unitCostCents===null||input.feeRate===null?null:
    Math.round(delta.oldPriceCents*(1-input.feeRate))-delta.unitCostCents;
   itemMarginAfterCents=delta.unitCostCents===null||input.feeRate===null?null:
    Math.round(delta.newPriceCents*(1-input.feeRate))-delta.unitCostCents;
  }else{
   weeklyChangeCents=Math.round((delta.oldCostCents-delta.newCostCents)*delta.weeklyUnits);
   itemMarginBeforeCents=delta.currentPriceCents-delta.oldCostCents;
   itemMarginAfterCents=delta.currentPriceCents-delta.newCostCents;
  }
  profitChangeCents=weeklyChangeCents===null?null:Math.round(weeklyChangeCents*weeklyFactor);
  if(afterInput.monthlyRevenue.valueCents!==null&&delta.kind==="price")
   afterInput.monthlyRevenue=figure(afterInput.monthlyRevenue.valueCents+
    Math.round((delta.newPriceCents-delta.oldPriceCents)*delta.weeklyUnits*weeklyFactor),
    "estimate","Price scenario");
  if(delta.kind==="item_cost"&&input.monthlyRevenue.valueCents&&input.ingredientRate!==null&&profitChangeCents!==null)
   afterInput.ingredientRate=Math.max(0,input.ingredientRate-profitChangeCents/input.monthlyRevenue.valueCents);
 }else if(delta.kind==="shift"||delta.kind==="wage"){
  const wages=delta.kind==="shift"?delta.hoursChange*delta.shiftsPerWeek*delta.wageCents:
   delta.weeklyHours*(delta.newWageCents-delta.oldWageCents);
  weeklyChangeCents=-Math.round(wages*(1+delta.payrollTaxRate));
  profitChangeCents=weeklyChangeCents===null?null:Math.round(weeklyChangeCents*weeklyFactor);
  afterInput.monthlyStaff=figure(input.monthlyStaff.valueCents===null||profitChangeCents===null?null:
    Math.max(0,input.monthlyStaff.valueCents-profitChangeCents),
   "estimate","Payroll scenario",input.monthlyStaff.missingDays);
 }else if(delta.kind==="drinks"){
  const revenue=input.monthlyRevenue.valueCents;
  if(revenue!==null&&input.ingredientRate!==null&&input.feeRate!==null){
   const variableRate=input.ingredientRate+input.feeRate;
   profitChangeCents=Math.round(revenue*delta.changePercent/100*(1-variableRate));
   weeklyChangeCents=Math.round(profitChangeCents/weeklyFactor);
   afterInput.monthlyRevenue=figure(revenue+Math.round(revenue*delta.changePercent/100),
    "estimate","Sales volume scenario");
  }else{
   profitChangeCents=null;
   weeklyChangeCents=null;
  }
 }else if(delta.kind==="margin"){
  targetMargin=delta.targetMargin;
 }
 const after=unifiedBreakEven(afterInput);
 const targetSales=(basis:Economics,margin:number)=>{
  const contribution=1-(basis.ingredientRate??1)-(basis.feeRate??1)-margin;
  if(basis.monthlyBills.valueCents===null||basis.monthlyStaff.valueCents===null||
    basis.ingredientRate===null||basis.feeRate===null||contribution<=0)return null;
  return Math.ceil((basis.monthlyBills.valueCents+basis.monthlyStaff.valueCents)/contribution);
 };
 const beforeTargetSales=targetSales(input,input.targetMargin);
 const afterTargetSales=targetSales(afterInput,targetMargin);
 const revenue=input.monthlyRevenue.valueCents;
 const fixed=before.monthlyFixedKnownCents;
 // A missing cost or variable rate never becomes a zero-cost "profit".
 const complete=input.monthlyBills.valueCents!==null&&input.monthlyStaff.valueCents!==null&&
  input.ingredientRate!==null&&input.feeRate!==null;
 const beforeProfitCents=revenue===null||!complete?null:
  Math.round(revenue*(1-input.ingredientRate!-input.feeRate!)-fixed);
 const afterProfitCents=beforeProfitCents===null||profitChangeCents===null?null:
  beforeProfitCents+profitChangeCents;
 return {before:{monthlyProfitCents:beforeProfitCents,monthlyBreakEvenCents:before.monthlyBreakEven.valueCents,
   drinksPerDay:before.drinksPerDay,itemMarginCents:itemMarginBeforeCents,
   monthlyTargetSalesCents:beforeTargetSales},
  after:{monthlyProfitCents:afterProfitCents,monthlyBreakEvenCents:after.monthlyBreakEven.valueCents,
   drinksPerDay:after.drinksPerDay,itemMarginCents:itemMarginAfterCents,
   monthlyTargetSalesCents:afterTargetSales},
  difference:{monthlyProfitCents:profitChangeCents,
   monthlyBreakEvenCents:before.monthlyBreakEven.valueCents===null||after.monthlyBreakEven.valueCents===null
    ?null:after.monthlyBreakEven.valueCents-before.monthlyBreakEven.valueCents,
   drinksPerDay:before.drinksPerDay===null||after.drinksPerDay===null?null:after.drinksPerDay-before.drinksPerDay},
  weeklyChangeCents,targetMargin,provenance:"estimate" as const,missing:[...new Set([...before.missing,...after.missing])]};
}
