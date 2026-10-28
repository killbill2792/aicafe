import {calculateBreakEvenSales,type BreakEvenSalesResult} from "@/lib/calc/breakEvenSales";
import {shiftCafeDate} from "./clock";
import {cardFeesForDays,type OwnerFeePlan} from "./fees";
export type BreakEvenDay={
  date:string;netSalesCents:number;ingredientsCents:number;cardFeesCents:number;
  drinksCount:number;salesDataStatus?:"actual"|"missing";
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
  notes.push(...feeResult.notes.filter(key=>key!=="feeNetSalesProxy"));
  const drinks=window.reduce((sum,d)=>sum+d.drinksCount,0);
  const result=calculateBreakEvenSales({
    monthlyBillsCents:input.monthlyBillsCents??0,
    monthlyStaffCents:input.monthlyStaffCents??0,
    observedSalesCents,observedIngredientCents,observedProcessingFeesCents,
  });
  if(result.kind!=="ready"||drinks<=0||input.daysInMonth<=0){
    notes.push(result.kind==="unavailable"?result.reason:"breakEvenDrinksMissing");
    return {salesPerMonthCents:null,drinksPerDay:null,calculation:result,knownCostFloorCents:null,coveredDays,
      expectedDays:28,notes};
  }
  const monthly=result.breakEvenSalesCents;
  const avgMoneyLeft=(observedSalesCents-observedIngredientCents-observedProcessingFeesCents)/drinks;
  const dailyCosts=(result.fixedMonthlyCostsCents/input.daysInMonth);
  const drinksPerDay=Math.ceil(dailyCosts/avgMoneyLeft);
  return {salesPerMonthCents:monthly,drinksPerDay,calculation:result,
    knownCostFloorCents:notes.some(n=>n.endsWith("Missing"))?monthly:null,
    coveredDays,expectedDays:28,notes};
}
