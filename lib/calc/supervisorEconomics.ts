import {calculateBreakEvenSales} from "./breakEvenSales";
import {breakEvenFor,type BreakEvenDay} from "@/lib/metrics/core/breakEven";
import {shiftCafeDate} from "@/lib/metrics/core/clock";
import {cardFeesForDays,type OwnerFeePlan} from "@/lib/metrics/core/fees";
import type {LaborRecord} from "@/lib/metrics/core/labor";
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
 laborCoveredDays?:number;laborWindowDays?:number;
 salesCoverage?:{from:string;to:string;openDays:number};
 feePlan?:{percentRate:number;fixedFeeCents:number;drinksPerOrder:number;processorLabel:string};
 /** Expected operating categories without current actual or recurring basis. */
 missingBillCategories?:string[];
 asOfDate?:string;observedDays?:BreakEvenDay[];
 ownerFeePlans?:readonly OwnerFeePlan[];
 laborEvidence?:{dates:readonly {date:string}[];records:readonly LaborRecord[]};
 /** Owner-supplied observations take precedence in this specific calculation only. */
 ownerNetSalesCents?:number|null;ownerSalesDays?:number|null;
 scenarioIngredientRateOverride?:number;
};
/** Weighted owner-confirmed processor rate from the SAME covered drinks/order window. */
export function fixedCardFeeForCoveredSales(plan:{
 processorLabel:string;processedSalesShareBps:number;processedTransactionShareBps:number;
 rules:readonly {percentageBps:number;fixedFeeCents:number;salesMixBps:number;transactionMixBps:number}[];
},drinksCount:number,ordersCount:number):Economics["feePlan"]{
 if(!Number.isFinite(drinksCount)||!Number.isFinite(ordersCount)||
  drinksCount<=0||ordersCount<=0)return undefined;
 const percentRate=plan.processedSalesShareBps/10000*plan.rules.reduce((sum,r)=>
  sum+r.percentageBps/10000*r.salesMixBps/10000,0);
 const fixedFeeCents=plan.processedTransactionShareBps/10000*plan.rules.reduce((sum,r)=>
  sum+r.fixedFeeCents*r.transactionMixBps/10000,0);
 if(!Number.isFinite(percentRate)||percentRate<0||percentRate>=1||
  !Number.isFinite(fixedFeeCents)||fixedFeeCents<=0)return undefined;
 return {percentRate,fixedFeeCents,drinksPerOrder:drinksCount/ordersCount,
  processorLabel:plan.processorLabel};
}
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
 const realDays=input.asOfDate?input.observedDays?.filter(day=>
   day.date>=shiftCafeDate(input.asOfDate!,-28)&&
   day.date<input.asOfDate!&&day.salesDataStatus!=="missing")??[]:[];
 const observedSalesCents=realDays.reduce((sum,d)=>sum+d.netSalesCents,0);
 const ownerSales=input.ownerNetSalesCents??null;
 if(ownerSales!==null&&(!Number.isSafeInteger(ownerSales)||ownerSales<0))
   throw new RangeError("Invalid owner sales observation");
 const calcSales=ownerSales??observedSalesCents;
 const sourceIngredients=realDays.reduce((sum,day)=>sum+day.ingredientsCents,0);
 const sourceFees=cardFeesForDays(realDays,input.ownerFeePlans??null).amountCents;
 // A stated owner percentage overrides imports for this scenario. Otherwise,
 // retain the real amounts, or scale their effective rates when the owner supplies sales.
 const ingredientCents=input.scenarioIngredientRateOverride!==undefined?
   Math.round(calcSales*input.scenarioIngredientRateOverride):
   input.ingredientStatus==="owner"&&input.ingredientRate!==null?
   Math.round(calcSales*input.ingredientRate):
   observedSalesCents>0?Math.round(sourceIngredients*calcSales/observedSalesCents):
   Math.round(calcSales*effectiveIngredientRate);
 const feeCents=input.feeStatus==="owner"&&input.feeRate!==null?
   Math.round(calcSales*input.feeRate):
   observedSalesCents>0?Math.round(sourceFees*calcSales/observedSalesCents):
   Math.round(calcSales*effectiveFeeRate);
 const shared=ownerSales===null&&input.asOfDate&&input.observedDays?breakEvenFor({
   days:realDays,asOfDate:input.asOfDate,daysInMonth:input.daysInMonth,
   monthlyBillsCents:input.monthlyBills.valueCents,
   monthlyStaffCents:input.monthlyStaff.valueCents??extrasFloor,
   observedIngredientCents:ingredientCents,
   observedProcessingFeesCents:feeCents,
   ownerFeePlans:input.ownerFeePlans,
 }):null;
 const computed=shared?.calculation??(
   ownerSales!==null?calculateBreakEvenSales({
     monthlyBillsCents:input.monthlyBills.valueCents??0,
     monthlyStaffCents:input.monthlyStaff.valueCents??extrasFloor,
     observedSalesCents:calcSales,
     observedIngredientCents:ingredientCents,
     observedProcessingFeesCents:feeCents,
   }):input.observedDays?{kind:"unavailable" as const,reason:"NO_SALES" as const}:
   calculateBreakEvenSales({
     monthlyBillsCents:input.monthlyBills.valueCents??0,
     monthlyStaffCents:input.monthlyStaff.valueCents??extrasFloor,
     observedSalesCents:100_000_000,
     observedIngredientCents:Math.round(100_000_000*effectiveIngredientRate),
     observedProcessingFeesCents:Math.round(100_000_000*effectiveFeeRate),
   }));
 // Observed costs can provide a meaningful known-cost break-even without a saved
 // percentage. Explicit missing inputs remain disclosed instead of becoming zero.
 const evidenceReady=ownerSales!==null||shared!==null||rateKnown;
 const monthlyCents=evidenceReady&&computed.kind==="ready"?computed.breakEvenSalesCents:null;
 const knownCostBreakEvenFloorCents=(fixed.length>0||extrasFloor>0)&&
   monthlyCents!==null?monthlyCents:null;
 const drinksPerDay=shared?shared.drinksPerDay:
   monthlyCents!==null&&input.averagePriceCents!==null&&input.averagePriceCents>0&&input.daysInMonth>0
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
/** Drink pricing: product-cost target sets the baseline; fully loaded economics
 * can only lift that baseline to break-even, never stack a model-selected margin. */
export function recommendFullCostPrice(input:{
 ingredientCents:number;packagingCents:number|null;laborCents:number|null;
 overheadCents:number|null;units:number|null;feeRate:number|null;targetMargin:number;
 targetDrinkCostPct?:number;knownOverheadCents?:number|null;fixedFeePerDrinkCents?:number;
}){
 const valid=(n:number|null)=>n!==null&&Number.isFinite(n)&&n>=0;
 const costPct=Math.max(.25,Math.min(.35,input.targetDrinkCostPct??COFFEE_SHOP_PROFILE.targetProductCostPercent));
 const operatingMargin=Math.max(0,Math.min(.30,input.targetMargin));
 const increment=COFFEE_SHOP_PROFILE.roundingRule.incrementCents;
 const roundUp25=(cents:number)=>Math.max(increment,Math.ceil((cents-1e-8)/increment)*increment);
 const productCost=input.packagingCents===null?null:input.ingredientCents+input.packagingCents;
 const laborPerUnit=input.units&&input.units>0&&valid(input.laborCents)
  ?input.laborCents!/input.units:null;
 const overheadPerUnit=input.units&&input.units>0&&valid(input.overheadCents)
  ?input.overheadCents!/input.units:null;
 const fee=input.feeRate;
 const fixedPerDrink=input.fixedFeePerDrinkCents??0;
 const missing=[...(productCost===null?["packagingCents"]:[]),
  ...(laborPerUnit===null?["laborPerUnit"]:[]),
  ...(overheadPerUnit===null?["overheadPerUnit"]:[]),
  ...(fee===null?["processingFeeRate"]:[])];
 if(!valid(input.ingredientCents)||fee!==null&&(!valid(fee)||fee>=1)||
  !Number.isFinite(input.targetMargin)||!Number.isFinite(costPct)||
  !Number.isFinite(fixedPerDrink)||fixedPerDrink<0){
  return {recommendedPriceCents:null,breakEvenCents:null,fullCostCents:null,
   profitPriceCents:null,knownCostFloorCents:null,knownCostFloorLabel:"floor, not a recommendation",
   targetDrinkCostPct:costPct,operatingMargin,warning:"invalidInputs",missing:["invalidInputs"],
   laborPerUnitCents:laborPerUnit,overheadPerUnitCents:overheadPerUnit};
 }
 const knownCost=input.ingredientCents+(input.packagingCents??0)+
  (laborPerUnit??0)+(overheadPerUnit??(input.units&&input.units>0&&valid(input.knownOverheadCents??null)?
    input.knownOverheadCents!/input.units:0));
 const knownCostFloorCents=missing.length?Math.ceil((knownCost+fixedPerDrink)/(1-(fee??0))):null;
 const fullCost=productCost!==null&&laborPerUnit!==null&&overheadPerUnit!==null?
  productCost+laborPerUnit+overheadPerUnit:null;
 const breakEvenCents=fullCost!==null&&fee!==null?Math.ceil((fullCost+fixedPerDrink)/(1-fee)):null;
 const baseline=productCost!==null?roundUp25(productCost/costPct):null;
 const warning=breakEvenCents===null?"full_cost_unknown":
  baseline!==null&&breakEvenCents>baseline?"below_full_cost":null;
 const recommendedPriceCents=baseline===null?null:
  breakEvenCents!==null&&breakEvenCents>baseline?roundUp25(breakEvenCents):baseline;
 const profitPriceCents=fullCost!==null&&fee!==null&&1-fee-operatingMargin>0?
  roundUp25((fullCost+fixedPerDrink)/(1-fee-operatingMargin)):null;
 return {recommendedPriceCents,breakEvenCents,
  fullCostCents:fullCost===null?null:Math.round(fullCost),profitPriceCents,
  knownCostFloorCents,knownCostFloorLabel:"floor, not a recommendation",
  targetDrinkCostPct:costPct,operatingMargin,warning,missing,
  laborPerUnitCents:laborPerUnit,overheadPerUnitCents:overheadPerUnit,
  fixedFeePerDrinkCents:fixedPerDrink};
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
