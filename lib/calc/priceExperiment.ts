import {ingredientOnlyEconomics} from "./alexPricingMath";

/** The projection assumes unchanged unit demand; it is not a profit forecast.
 * All observed/projected monetary totals and inputs are integer cents in the café's own currency. */
export type PriceExperimentBaseline={
  productId:string; productName:string;oldPriceCents:number;newPriceCents:number;
  ingredientCostCents:number;baselineUnits7Days:number; currency:string;
  estimateKind:"conditional_unchanged_demand";
};
export type PriceExperimentDay={
  businessDate:string;units:number;netSalesCents:number;
  coverage:"actual"|"unavailable"; source:string;
};
const cents=(n:number)=>Number.isSafeInteger(n)&&n>=0;
/** No trial increase may exceed 50% of the current price. */
export const MAX_TRIAL_INCREASE_BPS=5000;
const safeProduct=(a:number,b:number):number|null=>{
  if(!cents(a)||!cents(b))return null;
  const n=BigInt(a)*BigInt(b);
  return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
};
/** Signed contribution is allowed to be negative; money remains exact cents. */
const signedProduct=(a:number,b:number):number|null=>{
  if(!Number.isSafeInteger(a)||!cents(b))return null;
  const n=BigInt(a)*BigInt(b);
  return n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=-BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
};
export function simulatePriceExperiment(input:{
  productId:string;productName:string;currentPriceCents:number;increaseCents:number;
  ingredientCostCents:number|null;units7Days:number|null;
  /** The authenticated café's ISO 4217 currency. */
  currency:string;
}):PriceExperimentBaseline&{beforeContributionCents:number;afterContributionCents:number;
  estimatedAdditionalRevenue7DaysCents:number;estimatedAdditionalContribution7DaysCents:number}|null{
  const {currentPriceCents, increaseCents, ingredientCostCents,units7Days}=input;
  if(!input.productId||!input.productName||!cents(currentPriceCents)||
    !cents(increaseCents)||increaseCents===0||currentPriceCents===0||
    BigInt(increaseCents)*BigInt(10000)>BigInt(currentPriceCents)*BigInt(MAX_TRIAL_INCREASE_BPS)||
    ingredientCostCents===null||
    !cents(ingredientCostCents)||units7Days===null||!cents(units7Days))return null;
  const newPriceCents=currentPriceCents+increaseCents;
  if(!Number.isSafeInteger(newPriceCents))return null;
  const before=ingredientOnlyEconomics(ingredientCostCents,currentPriceCents);
  const after=ingredientOnlyEconomics(ingredientCostCents,newPriceCents);
  const delta=safeProduct(increaseCents,units7Days);
  if(!before||!after||before.ingredientContributionCents===null||
    after.ingredientContributionCents===null||delta===null)return null;
  return {productId:input.productId,productName:input.productName,oldPriceCents:currentPriceCents,
    newPriceCents,ingredientCostCents,baselineUnits7Days:units7Days,currency:input.currency,
    estimateKind:"conditional_unchanged_demand",beforeContributionCents:before.ingredientContributionCents,
    afterContributionCents:after.ingredientContributionCents,
    estimatedAdditionalRevenue7DaysCents:delta,estimatedAdditionalContribution7DaysCents:delta};
}
export function evaluatePriceExperiment(baseline:PriceExperimentBaseline,days:readonly PriceExperimentDay[],
  expectedDays=7):{
    status:"in_progress"|"complete"|"insufficient_evidence";
    coveredDays:number;units:number|null;observedRevenueCents:number|null;
    baselineAtObservedVolumeCents:number|null;realizedRevenueDifferenceCents:number|null;
    observedIngredientContributionCents:number|null;
    expectedUpliftAtObservedVolumeCents:number|null;
    baselineRevenue7DaysCents:number|null;
    baselineIngredientContribution7DaysCents:number|null;
    revenueChangeVsBaselineCents:number|null;
    ingredientContributionChangeVsBaselineCents:number|null;
    recommendation:"keep"|"revert"|"adjust";
    caveat:"no_causal_demand_attribution";
  }{
  const covered=days.filter(day=>day.coverage==="actual"&&
    cents(day.units)&&cents(day.netSalesCents)&&/^\d{4}-\d{2}-\d{2}$/.test(day.businessDate));
  const byDate=new Set(covered.map(day=>day.businessDate));
  const valid=covered.length===days.length&&byDate.size===covered.length&&covered.length<=expectedDays;
  if(!valid||!covered.length)return {status:"insufficient_evidence",coveredDays:0,
    units:null,observedRevenueCents:null,baselineAtObservedVolumeCents:null,
    realizedRevenueDifferenceCents:null,observedIngredientContributionCents:null,
    expectedUpliftAtObservedVolumeCents:null,baselineRevenue7DaysCents:null,
    baselineIngredientContribution7DaysCents:null,revenueChangeVsBaselineCents:null,
    ingredientContributionChangeVsBaselineCents:null,recommendation:"adjust",
    caveat:"no_causal_demand_attribution"};
  const qty=covered.reduce((n,d)=>n+d.units,0);
  const revenue=covered.reduce((n,d)=>n+d.netSalesCents,0);
  const oldTotal=safeProduct(baseline.oldPriceCents,qty);
  const added=safeProduct(baseline.newPriceCents-baseline.oldPriceCents,qty);
  const cost=safeProduct(baseline.ingredientCostCents,qty);
  if(!cents(qty)||!cents(revenue)||oldTotal===null||added===null||cost===null||
    !Number.isSafeInteger(revenue-oldTotal)||!Number.isSafeInteger(revenue-cost))
    return {status:"insufficient_evidence",coveredDays:0,units:null,
      observedRevenueCents:null,baselineAtObservedVolumeCents:null,
      realizedRevenueDifferenceCents:null,observedIngredientContributionCents:null,
      expectedUpliftAtObservedVolumeCents:null,baselineRevenue7DaysCents:null,
     baselineIngredientContribution7DaysCents:null,revenueChangeVsBaselineCents:null,
     ingredientContributionChangeVsBaselineCents:null,recommendation:"adjust",
      caveat:"no_causal_demand_attribution"};
  const difference=revenue-oldTotal;
  const previousRevenue=safeProduct(baseline.oldPriceCents,baseline.baselineUnits7Days);
  const previousContribution=signedProduct(
    baseline.oldPriceCents-baseline.ingredientCostCents,baseline.baselineUnits7Days);
  const actualContribution=revenue-cost;
  const actualRevenueChange=previousRevenue===null?null:revenue-previousRevenue;
  const actualContributionChange=previousContribution===null?null:actualContribution-previousContribution;
  if(previousRevenue===null||previousContribution===null||
    actualRevenueChange===null||actualContributionChange===null||
    !Number.isSafeInteger(actualRevenueChange)||!Number.isSafeInteger(actualContributionChange))
    return {status:"insufficient_evidence",coveredDays:covered.length,units:null,
      observedRevenueCents:null,baselineAtObservedVolumeCents:null,
      realizedRevenueDifferenceCents:null,observedIngredientContributionCents:null,
      expectedUpliftAtObservedVolumeCents:null,baselineRevenue7DaysCents:null,
      baselineIngredientContribution7DaysCents:null,revenueChangeVsBaselineCents:null,
      ingredientContributionChangeVsBaselineCents:null,recommendation:"adjust",
      caveat:"no_causal_demand_attribution"};
  // This is an observed before/after comparison, not a causal elasticity claim.
  // The pinned previous *7-day volume* must be honored: comparing only the
  // same observed volume makes a price uplift look successful despite collapse.
  const recommendation=covered.length!==expectedDays||qty===0||
    baseline.baselineUnits7Days===0?"adjust":
    actualContributionChange<0?"revert":
    actualContributionChange>=added?"keep":"adjust";
  return {status:covered.length===expectedDays?"complete":"in_progress",
    coveredDays:covered.length,units:qty,observedRevenueCents:revenue,
    baselineAtObservedVolumeCents:oldTotal,realizedRevenueDifferenceCents:difference,
    observedIngredientContributionCents:actualContribution,
    expectedUpliftAtObservedVolumeCents:added,
    baselineRevenue7DaysCents:previousRevenue,
    baselineIngredientContribution7DaysCents:previousContribution,
    revenueChangeVsBaselineCents:actualRevenueChange,
    ingredientContributionChangeVsBaselineCents:actualContributionChange,
    recommendation,
    caveat:"no_causal_demand_attribution"};
}

/** Canonical sum of observed, verified line-item money; no arithmetic in server
 * adapters, no float cents and no inferred missing days. */
export function aggregatePriceExperimentSalesRows(rows:readonly {
  quantity:number;netSalesCents:number}[]):{units:number;netSalesCents:number}|null{
  let units=BigInt(0),netSalesCents=BigInt(0);
  for(const r of rows){
    if(!cents(r.quantity)||!cents(r.netSalesCents))return null;
    units+=BigInt(r.quantity);netSalesCents+=BigInt(r.netSalesCents);
  }
  if(units>BigInt(Number.MAX_SAFE_INTEGER)||netSalesCents>BigInt(Number.MAX_SAFE_INTEGER))return null;
  return {units:Number(units),netSalesCents:Number(netSalesCents)};
}

/** Captured effect's immutable assumptions projected through canonical integer
 * arithmetic. Display layers must NEVER multiply money/units themselves. */
export function priceExperimentEstimatedUplift(baseline:PriceExperimentBaseline):number|null{
  if(!cents(baseline.newPriceCents)||!cents(baseline.oldPriceCents)||
    baseline.newPriceCents<baseline.oldPriceCents)return null;
  return safeProduct(baseline.newPriceCents-baseline.oldPriceCents,baseline.baselineUnits7Days);
}

/** Comparable exposure economics, shared by price watches and approved
 * experiments. Cost provenance is explicit: a current recipe is not a
 * historical actual cost. Negative net sales may reflect refunds. */
export function comparePriceExposure(input:{
 units:number|null;revenueCents:number|null;baselineUnits:number|null;
 baselineRevenueCents:number|null;unitCostEstimateCents:number|null;
 baselineUnitCostEstimateCents?:number|null;
}){
 const money=(n:number|null)=>n!==null&&Number.isSafeInteger(n)?n:null;
 const qty=(n:number|null)=>n!==null&&Number.isFinite(n)&&n>=0?n:null;
 const units=qty(input.units),baselineUnits=qty(input.baselineUnits);
 const revenue=money(input.revenueCents),baselineRevenue=money(input.baselineRevenueCents);
 const contribution=(u:number|null,r:number|null,c:number|null)=>{
  if(u===null||r===null)return null;
  if(u===0)return r;
  if(c===null||!Number.isFinite(c)||c<=0)return null;
  return money(Math.round(r-u*c));
 };
 const current=contribution(units,revenue,input.unitCostEstimateCents);
 const before=contribution(baselineUnits,baselineRevenue,
  input.baselineUnitCostEstimateCents===undefined?input.unitCostEstimateCents:input.baselineUnitCostEstimateCents);
 const difference=(a:number|null,b:number|null)=>a===null||b===null?null:money(a-b);
 const percent=(a:number|null,b:number|null)=>a===null||b===null||b<=0?null:
  money(Math.round((a-b)*10000/b));
 const margin=(c:number|null,r:number|null)=>c===null||r===null||r<=0?null:
  money(Math.round(c*10000/r));
 const contributionChange=difference(current,before);
 const revenueChange=difference(revenue,baselineRevenue);
 const recommendation=contributionChange===null||units===null||baselineUnits===null||
  units===0||baselineUnits===0?"adjust":
  contributionChange<0?"review_revert":contributionChange>0&&revenueChange!==null&&revenueChange>=0?"review_keep":"adjust";
 return {observedUnits:units,observedRevenueCents:revenue,baselineUnits,
  baselineRevenueCents:baselineRevenue,volumeChangeBps:percent(units,baselineUnits),
  revenueChangeBps:percent(revenue,baselineRevenue),revenueChangeCents:revenueChange,
  contributionEstimateCents:current,baselineContributionEstimateCents:before,
  contributionChangeEstimateCents:contributionChange,
  contributionMarginEstimateBps:margin(current,revenue),
  baselineContributionMarginEstimateBps:margin(before,baselineRevenue),
  costBasis:input.unitCostEstimateCents===null?"missing":"current_cost_estimate",
  recommendation,nonCausal:true as const};
}
