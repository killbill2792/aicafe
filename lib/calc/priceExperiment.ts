/** Canonical integer-cent arithmetic for a reversible, owner-approved price experiment.
 * The forecast holds units fixed and is never represented as an observed profit change.
 */
export type ExperimentDay={businessDate:string;units:number|null;revenueCents:number|null;actual:boolean};
export type ExperimentTotals={units:number;revenueCents:number;ingredientContributionCents:number};
export type ExperimentSimulation={
  status:"estimated"|"unavailable";
  fromPriceCents:number;toPriceCents:number;ingredientCostCents:number|null;
  baseline:ExperimentTotals|null;
  forecast:ExperimentTotals|null;estimatedDeltaRevenueCents:number|null;
  limitations:readonly string[];
};
export type ExperimentReport={
  status:"complete"|"in_progress"|"insufficient_evidence";
  observed:ExperimentTotals|null;baseline:ExperimentTotals|null;
  forecast:ExperimentTotals|null;
  observedVsBaselineContributionCents:number|null;
  observedVsForecastRevenueCents:number|null;
  recommendation:"keep"|"revert"|"adjust"|"unavailable";
  verifiedDays:number;requiredDays:number;
};
const money=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const count=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const safe=(n:number)=>Number.isSafeInteger(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER;
export function totalExperimentDays(days:readonly ExperimentDay[],ingredientCostCents:number):ExperimentTotals|null{
  if(!money(ingredientCostCents)||days.length===0||days.some(d=>!d.actual||d.units===null||
    d.revenueCents===null||!count(d.units)||!money(d.revenueCents)))return null;
  const units=days.reduce((n,d)=>n+d.units!,0);
  const revenueCents=days.reduce((n,d)=>n+d.revenueCents!,0);
  const ingredientContributionCents=revenueCents-units*ingredientCostCents;
  return safe(units)&&safe(revenueCents)&&safe(ingredientContributionCents)?
    {units,revenueCents,ingredientContributionCents}:null;
}
export function simulateDrinkPriceExperiment(input:{
  fromPriceCents:number;deltaCents:number;ingredientCostCents:number|null;baselineDays:readonly ExperimentDay[];
}):ExperimentSimulation{
  const {fromPriceCents,deltaCents,ingredientCostCents,baselineDays}=input;
  if(!money(fromPriceCents)||!Number.isSafeInteger(deltaCents)||deltaCents===0||
    Math.abs(deltaCents)>10000||!money(fromPriceCents+deltaCents))
    throw new Error("invalid_price_change");
  const toPriceCents=fromPriceCents+deltaCents;
  const cost=ingredientCostCents!==null&&money(ingredientCostCents)?ingredientCostCents:null;
  const baseline=cost!==null?totalExperimentDays(baselineDays,cost):null;
  if(!baseline)return {status:"unavailable",fromPriceCents,toPriceCents,ingredientCostCents:cost,
    baseline:null,forecast:null,estimatedDeltaRevenueCents:null,
    limitations:["missing_complete_baseline_or_ingredient_cost"]};
  const delta=baseline.units*deltaCents;
  const forecastRevenue=baseline.revenueCents+delta;
  const forecastContribution=baseline.ingredientContributionCents+delta;
  if(!safe(delta)||!safe(forecastRevenue)||!safe(forecastContribution)||forecastRevenue<0)
    throw new Error("arithmetic_overflow");
  return {status:"estimated",fromPriceCents,toPriceCents,ingredientCostCents:cost,
    baseline,forecast:{units:baseline.units,revenueCents:forecastRevenue,
      ingredientContributionCents:forecastContribution},
    estimatedDeltaRevenueCents:delta,
    limitations:["constant_volume_assumption","ingredient_only_not_net_profit","sales_may_change"]};
}
export function reportDrinkPriceExperiment(input:{
  simulation:ExperimentSimulation;days:readonly ExperimentDay[];requiredDays:number;windowElapsed:boolean;
}):ExperimentReport{
  const {simulation,days,requiredDays,windowElapsed}=input;
  if(!Number.isSafeInteger(requiredDays)||requiredDays<1||requiredDays>31)
    throw new Error("invalid_monitoring_window");
  const covered=new Set(days.filter(d=>d.actual&&d.units!==null&&d.revenueCents!==null)
    .map(d=>d.businessDate));
  const ready=covered.size===requiredDays&&days.length===requiredDays;
  const observed=simulation.ingredientCostCents!==null&&days.length>0?
    totalExperimentDays(days,simulation.ingredientCostCents):null;
  const base=simulation.baseline;
  const forecast=simulation.forecast;
  const compare=ready&&observed&&base?
    observed.ingredientContributionCents-base.ingredientContributionCents:null;
  const variance=ready&&observed&&forecast?
    observed.revenueCents-forecast.revenueCents:null;
  // A money-result remains unavailable without complete observed coverage.
  // No elasticity/demand counterfactual is claimed from this before/after comparison.
  const recommendation=compare===null?"unavailable":
    compare>0?"keep":compare<0?"revert":"adjust";
  return {
    status:ready&&windowElapsed&&base?"complete":windowElapsed?"insufficient_evidence":"in_progress",
    observed:ready?observed:null,baseline:base,forecast,
    observedVsBaselineContributionCents:compare,
    observedVsForecastRevenueCents:variance,
    recommendation:ready&&windowElapsed?recommendation:"unavailable",
    verifiedDays:covered.size,requiredDays,
  };
}
export function addBusinessDays(day:string,count:number):string{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isSafeInteger(count)||Math.abs(count)>366)
    throw new Error("invalid_business_date");
  const d=new Date(day+"T12:00:00Z");
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day)
    throw new Error("invalid_business_date");
  d.setUTCDate(d.getUTCDate()+count);
  return d.toISOString().slice(0,10);
}
