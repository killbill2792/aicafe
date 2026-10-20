import {ingredientOnlyEconomics} from "./alexPricingMath";

/** The projection assumes unchanged unit demand; it is not a profit forecast.
 * All observed/projected monetary totals and inputs are integer USD cents. */
export type PriceExperimentBaseline={
  productId:string; productName:string;oldPriceCents:number;newPriceCents:number;
  ingredientCostCents:number;baselineUnits7Days:number; currency:"USD";
  estimateKind:"conditional_unchanged_demand";
};
export type PriceExperimentDay={
  businessDate:string;units:number;netSalesCents:number;
  coverage:"actual"|"unavailable"; source:string;
};
const cents=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const safeProduct=(a:number,b:number):number|null=>{
  if(!cents(a)||!cents(b))return null;
  const n=BigInt(a)*BigInt(b);
  return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
};
export function simulatePriceExperiment(input:{
  productId:string;productName:string;currentPriceCents:number;increaseCents:number;
  ingredientCostCents:number|null;units7Days:number|null;
}):PriceExperimentBaseline&{beforeContributionCents:number;afterContributionCents:number;
  estimatedAdditionalRevenue7DaysCents:number;estimatedAdditionalContribution7DaysCents:number}|null{
  const {currentPriceCents, increaseCents, ingredientCostCents,units7Days}=input;
  if(!input.productId||!input.productName||!cents(currentPriceCents)||
    !cents(increaseCents)||increaseCents===0||ingredientCostCents===null||
    !cents(ingredientCostCents)||units7Days===null||!cents(units7Days))return null;
  const newPriceCents=currentPriceCents+increaseCents;
  if(!Number.isSafeInteger(newPriceCents))return null;
  const before=ingredientOnlyEconomics(ingredientCostCents,currentPriceCents);
  const after=ingredientOnlyEconomics(ingredientCostCents,newPriceCents);
  const delta=safeProduct(increaseCents,units7Days);
  if(!before||!after||before.ingredientContributionCents===null||
    after.ingredientContributionCents===null||delta===null)return null;
  return {productId:input.productId,productName:input.productName,oldPriceCents:currentPriceCents,
    newPriceCents,ingredientCostCents,baselineUnits7Days:units7Days,currency:"USD",
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
    expectedUpliftAtObservedVolumeCents:null,recommendation:"adjust",
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
      expectedUpliftAtObservedVolumeCents:null,recommendation:"adjust",
      caveat:"no_causal_demand_attribution"};
  const difference=revenue-oldTotal;
  return {status:covered.length===expectedDays?"complete":"in_progress",
    coveredDays:covered.length,units:qty,observedRevenueCents:revenue,
    baselineAtObservedVolumeCents:oldTotal,realizedRevenueDifferenceCents:difference,
    observedIngredientContributionCents:revenue-cost,
    expectedUpliftAtObservedVolumeCents:added,
    recommendation:covered.length!==expectedDays||qty===0?"adjust":
      difference>=added?"keep":difference<0?"revert":"adjust",
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
