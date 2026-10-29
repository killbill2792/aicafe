import {calculateBreakEvenSales,type BreakEvenSalesResult} from "@/lib/calc/breakEvenSales";
import {shiftCafeDate} from "./clock";
/** Pure scalar break-even primitives used by the B window and legacy what-if API. */
export function moneyLeftPerDrinkCents(sales:number,ingredients:number,fees:number,drinks:number):number{
  return drinks===0?0:(sales-ingredients-fees)/drinks;
}
export function moneyLeftAfterPriceChangeCents(oldMoneyLeft:number,deltaPriceCents:number,feeRate:number):number{
 if(!Number.isFinite(feeRate)||feeRate<0||feeRate>=1)throw new RangeError("Invalid marginal card-fee rate");
 return oldMoneyLeft+deltaPriceCents*(1-feeRate);
}
export function dailyBreakEvenCostsCents(bills:number,staff:number):number{
  return bills+staff;
}
export function drinksTargetPerDay(dailyCosts:number,moneyLeft:number):number{
  return moneyLeft<=0?Infinity:Math.ceil(dailyCosts/moneyLeft);
}

import {cardFeesForDays,type OwnerFeePlan} from "./fees";
export type BreakEvenDay={
  date:string;netSalesCents:number;ingredientsCents:number;cardFeesCents:number;
  drinksCount:number;ordersCount?:number|null;salesDataStatus?:"actual"|"missing";
  cardFeesStatus?:"actual"|"estimated"|"missing";
};
export type BreakEvenResult={
  salesPerMonthCents:number|null;drinksPerDay:number|null;calculation:BreakEvenSalesResult;
  knownCostFloorCents:number|null;coveredDays:number;expectedDays:28;
  notes:string[];
};
export function breakEvenFor(input:{
  days:readonly BreakEvenDay[];asOfDate:string;daysInMonth:number;
  monthlyBillsCents:number|null;monthlyStaffCents:number|null;
  observedIngredientCents?:number|null;observedProcessingFeesCents?:number|null;
  ownerFeePlans?:readonly OwnerFeePlan[];
}):BreakEvenResult{
  const start=shiftCafeDate(input.asOfDate,-28);
  const end=shiftCafeDate(input.asOfDate,-1);
  const window=input.days.filter(day=>day.date>=start&&day.date<=end&&day.salesDataStatus!=="missing");
  const notes:string[]=[];
  const coveredDays=new Set(window.map(d=>d.date)).size;
  if(coveredDays<28)notes.push("breakEvenCoveragePartial");
  if(input.monthlyBillsCents===null)notes.push("breakEvenBillsMissing");
  if(input.monthlyStaffCents===null)notes.push("breakEvenLaborMissing");
  const observedSalesCents=window.reduce((sum,d)=>sum+d.netSalesCents,0);
  const observedIngredientCents=input.observedIngredientCents??window.reduce((sum,d)=>sum+d.ingredientsCents,0);
  const feeResult=cardFeesForDays(window,input.ownerFeePlans??null);
  const observedProcessingFeesCents=input.observedProcessingFeesCents??feeResult.amountCents;
  notes.push(...feeResult.notes);
  const drinks=window.reduce((sum,d)=>sum+d.drinksCount,0);
  const result=calculateBreakEvenSales({
    monthlyBillsCents:input.monthlyBillsCents??0,
    monthlyStaffCents:input.monthlyStaffCents??0,
    observedSalesCents,observedIngredientCents,observedProcessingFeesCents,
  });
  if(result.kind!=="ready"){
    notes.push(result.kind==="unavailable"?result.reason:"breakEvenDrinksMissing");
    return {salesPerMonthCents:null,drinksPerDay:null,calculation:result,knownCostFloorCents:null,coveredDays,
      expectedDays:28,notes};
  }
  const monthly=result.breakEvenSalesCents;
  const avgMoneyLeft=moneyLeftPerDrinkCents(
    observedSalesCents,observedIngredientCents,observedProcessingFeesCents,drinks);
  const dailyCosts=input.daysInMonth>0?result.fixedMonthlyCostsCents/input.daysInMonth:0;
  const drinksPerDay=drinks>0&&input.daysInMonth>0?drinksTargetPerDay(dailyCosts,avgMoneyLeft):null;
  if(drinks<=0)notes.push("breakEvenDrinksMissing");
  if(input.daysInMonth<=0)notes.push("breakEvenCalendarMissing");
  return {salesPerMonthCents:monthly,drinksPerDay,calculation:result,
    knownCostFloorCents:notes.some(n=>n.endsWith("Missing"))?monthly:null,
    coveredDays,expectedDays:28,notes};
}
