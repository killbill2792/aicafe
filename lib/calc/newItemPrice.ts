import { baselinePriceCents } from "./pricingBaseline";
import { applyRounding } from "./pricingRounding";
import { COFFEE_SHOP_PROFILE } from "@/lib/pricing/profiles";

export type NewItemPriceInput = {
  ingredientCostCents:number; packagingCents:number|null; targetMarginPercent:number|null;
  labor30dCents:number|null; monthlyBillsCents:number|null; units30d:number|null;
  menuPricesCents:number[];
};
export function calculateNewItemPrice(input:NewItemPriceInput) {
  const missing:string[]=["localCompetitorPricesNotAvailable"];
  const estimated:string[]=["monthlyBillsAs30DayOverhead"];
  const packagingCents=input.packagingCents??0;
  if(input.packagingCents===null)estimated.push("packagingAssumedZero");
  const units=input.units30d && input.units30d>0?input.units30d:null;
  if(units===null)missing.push("itemSales30d");
  if(input.labor30dCents===null)missing.push("labor30d");
  if(input.monthlyBillsCents===null)missing.push("monthlyBills");
  const laborPerItemCents=units!==null&&input.labor30dCents!==null?Math.round(input.labor30dCents/units):null;
  const overheadPerItemCents=units!==null&&input.monthlyBillsCents!==null?Math.round(input.monthlyBillsCents/units):null;
  const fullCostCents=laborPerItemCents===null||overheadPerItemCents===null?null:
    input.ingredientCostCents+packagingCents+laborPerItemCents+overheadPerItemCents;
  const targetMarginPercent=input.targetMarginPercent??COFFEE_SHOP_PROFILE.targetOperatingMargin*100;
  if(input.targetMarginPercent===null)estimated.push("defaultTargetMargin");
  const costPlusPriceCents=fullCostCents===null?null:Math.round(fullCostCents/(1-targetMarginPercent/100));
  const ingredientBenchmarkCents=Math.round(baselinePriceCents(input.ingredientCostCents,COFFEE_SHOP_PROFILE.targetProductCostPercent));
  const rawPrice=Math.max(costPlusPriceCents??0,ingredientBenchmarkCents);
  // Do not present a benchmark as full-cost pricing when labor/overhead are missing.
  const suggestedPriceCents=fullCostCents===null?null:Math.max(COFFEE_SHOP_PROFILE.roundingRule.incrementCents,applyRounding(rawPrice,COFFEE_SHOP_PROFILE.roundingRule));
  const prices=input.menuPricesCents.filter(v=>Number.isSafeInteger(v)&&v>0).sort((a,b)=>a-b);
  const median=prices.length?(prices.length%2?prices[(prices.length-1)/2]:
    Math.round((prices[prices.length/2-1]+prices[prices.length/2])/2)):null;
  return {
    ingredientCostCents:input.ingredientCostCents,packagingCents,labor30dCents:input.labor30dCents,
    monthlyBillsCents:input.monthlyBillsCents,units30d:units,laborPerItemCents,overheadPerItemCents,
    fullCostCents,costPlusPriceCents,ingredientBenchmarkCents,targetMarginPercent,
    suggestedPriceCents,ownMenuRange:{min:prices[0]??null,median,max:prices.at(-1)??null,count:prices.length},
    profitPerItemCents:suggestedPriceCents===null||fullCostCents===null?null:suggestedPriceCents-fullCostCents,
    marginPercent:suggestedPriceCents===null||fullCostCents===null?null:
      Math.round((suggestedPriceCents-fullCostCents)/suggestedPriceCents*10000)/100,
    missing,estimated,
  };
}
