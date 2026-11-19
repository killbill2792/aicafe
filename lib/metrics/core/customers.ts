/** Shared interpretation of DB-aggregated customer evidence. No per-person
 * data leaves the canonical reader for monitoring; no alternate calculation
 * of check/visit money or attribution. */
export type CustomerPeriod={
 checks:number;linkedChecks:number;namedChecks:number;visits:number;references:number;
 firstVisits:number;returningVisits:number;knownMoneyVisits:number;averageSpendCents:number|null;
 /** Concentration is the sum of squared shares over all linked period accounts. */
 linkedRevenueConcentration?:number|null;
 observedDiscountShare?:number|null;observedLoyaltyShare?:number|null;recordedRefundCentsPerCheck?:number|null;
 observedMeanOrderDurationSeconds?:number|null;
 knownContributionVisits?:number;averageRecipeContributionCents?:number|null;
 knownHistoryAccounts?:number;averageHistoryAccountCents?:number|null;
 complete:boolean;
};
export type CustomerCohort={matured:number;observedReturns:number;complete:boolean};
export type CustomerCohortHorizon=7|30|60|90;
export type CustomerMeasure={key:string;current:number;previous:number;unit:string;active:boolean};
/** Conservative notification heuristics: use the existing anomaly 20% change
 * threshold, plus minimum support/comparable linkage to prevent few known
 * customers or a source mix change masquerading as a business trend. These
 * are review thresholds, not population estimates or statistical tests. */
export const CUSTOMER_MONITOR_POLICY={minimumLinkedChecks:30,minimumVisits:30,
 minimumIdentityCoverage:.8,maximumCoverageChange:.1,minimumCohort:30,
 minimumRelativeChange:.2,minimumRateChange:.1} as const;
const valid=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const count=(v:unknown)=>valid(v)&&Number.isSafeInteger(v)&&v>=0;
export function customerPeriodValid(p:CustomerPeriod):boolean{
 return p.complete&&[p.checks,p.linkedChecks,p.namedChecks,p.visits,p.references,p.firstVisits,
  p.returningVisits,p.knownMoneyVisits].every(count)&&p.linkedChecks<=p.checks&&
  p.namedChecks<=p.checks&&p.visits<=p.linkedChecks&&p.references<=p.visits&&(p.visits===0||p.references>0)&&
  p.firstVisits+p.returningVisits===p.visits&&p.knownMoneyVisits<=p.visits;
}
export const identityCoverage=(p:CustomerPeriod)=>p.checks>0?p.linkedChecks/p.checks:null;
export function customerCoverageReady(p:CustomerPeriod):boolean{
 const coverage=identityCoverage(p);
 return customerPeriodValid(p)&&p.linkedChecks>=CUSTOMER_MONITOR_POLICY.minimumLinkedChecks&&
  p.visits>=CUSTOMER_MONITOR_POLICY.minimumVisits&&coverage!==null&&coverage>=CUSTOMER_MONITOR_POLICY.minimumIdentityCoverage;
}
function comparable(a:CustomerPeriod,b:CustomerPeriod):boolean{
 const ac=identityCoverage(a),bc=identityCoverage(b);
 return customerCoverageReady(a)&&customerCoverageReady(b)&&ac!==null&&bc!==null&&
  Math.abs(ac-bc)<=CUSTOMER_MONITOR_POLICY.maximumCoverageChange;
}
function measure(key:string,current:number,previous:number,unit:string,rate=false,signed=false):CustomerMeasure|null{
 if(!valid(current)||!valid(previous)||(!signed&&(current<0||previous<0)))return null;
 // A zero baseline has no percentage change. Treat zero-to-positive as
 // material only with the minimum source support already checked by caller.
 const diff=Math.abs(current-previous);
 const active=rate?diff>=CUSTOMER_MONITOR_POLICY.minimumRateChange:
  previous===0?diff>0:diff/Math.abs(previous)>=CUSTOMER_MONITOR_POLICY.minimumRelativeChange;
 return {key,current,previous,unit,active};
}
export function compareCustomerPeriods(current:CustomerPeriod,previous:CustomerPeriod):CustomerMeasure[]{
 if(!comparable(current,previous))return [];
 const measures=[
  measure("observed_references",current.references,previous.references,"observed_account_references"),
  measure("observed_first_visits",current.firstVisits,previous.firstVisits,"first_observed_visits"),
  measure("returning_visit_share",current.returningVisits/current.visits,previous.returningVisits/previous.visits,"observed_visit_ratio",true),
  measure("visits_per_reference",current.visits/current.references,previous.visits/previous.references,"visits_per_observed_reference"),
  current.knownMoneyVisits===current.visits&&previous.knownMoneyVisits===previous.visits&&
   valid(current.averageSpendCents)&&valid(previous.averageSpendCents)?
   measure("period_net_per_reference",current.averageSpendCents*current.visits/current.references,
    previous.averageSpendCents*previous.visits/previous.references,"recorded_period_cents_per_observed_reference",false,true):null,
  current.knownHistoryAccounts===current.references&&previous.knownHistoryAccounts===previous.references&&
   valid(current.averageHistoryAccountCents)&&valid(previous.averageHistoryAccountCents)?
   measure("observed_history_value",current.averageHistoryAccountCents,previous.averageHistoryAccountCents,
    "recorded_history_cents_per_active_reference_not_forecast",false,true):null,
  valid(current.linkedRevenueConcentration)&&valid(previous.linkedRevenueConcentration)&&
    current.linkedRevenueConcentration<=1&&previous.linkedRevenueConcentration<=1&&
    current.knownMoneyVisits===current.visits&&previous.knownMoneyVisits===previous.visits?
   measure("linked_revenue_concentration",current.linkedRevenueConcentration,previous.linkedRevenueConcentration,"linked_revenue_share_squared"):null,
  valid(current.observedDiscountShare)&&valid(previous.observedDiscountShare)&&current.observedDiscountShare<=1&&previous.observedDiscountShare<=1?
   measure("observed_discount_participation",current.observedDiscountShare,previous.observedDiscountShare,"observed_linked_check_discount_share",true):null,
  valid(current.observedLoyaltyShare)&&valid(previous.observedLoyaltyShare)&&current.observedLoyaltyShare<=1&&previous.observedLoyaltyShare<=1?
   measure("observed_loyalty_participation",current.observedLoyaltyShare,previous.observedLoyaltyShare,"observed_linked_check_loyalty_share",true):null,
  valid(current.observedMeanOrderDurationSeconds)&&valid(previous.observedMeanOrderDurationSeconds)?
   measure("observed_order_duration",current.observedMeanOrderDurationSeconds,previous.observedMeanOrderDurationSeconds,"recorded_seconds_per_linked_visit"):null,
  valid(current.recordedRefundCentsPerCheck)&&valid(previous.recordedRefundCentsPerCheck)?
   measure("recorded_refund_per_linked_check",current.recordedRefundCentsPerCheck,previous.recordedRefundCentsPerCheck,"recorded_refund_cents_per_linked_check"):null,
  current.knownContributionVisits===current.visits&&previous.knownContributionVisits===previous.visits&&
    valid(current.averageRecipeContributionCents)&&valid(previous.averageRecipeContributionCents)?
   measure("average_recipe_contribution",current.averageRecipeContributionCents,previous.averageRecipeContributionCents,
    "historical_theoretical_ingredient_contribution_cents_per_linked_visit",false,true):null,
  current.knownMoneyVisits===current.visits&&previous.knownMoneyVisits===previous.visits&&
    current.averageSpendCents!==null&&previous.averageSpendCents!==null?
   measure("average_visit_spend",current.averageSpendCents,previous.averageSpendCents,"recorded_cents_per_linked_visit"):null,
 ];
 return measures.filter((x):x is CustomerMeasure=>x!==null);
}
export function compareCustomerCohorts(current:CustomerCohort,previous:CustomerCohort,
 currentPeriod:CustomerPeriod,previousPeriod:CustomerPeriod,horizon:CustomerCohortHorizon=7):CustomerMeasure|null{
 if(!comparable(currentPeriod,previousPeriod)||![current,previous].every(x=>x.complete&&count(x.matured)&&
   count(x.observedReturns)&&x.observedReturns<=x.matured&&x.matured>=CUSTOMER_MONITOR_POLICY.minimumCohort))return null;
 return measure(`observed_return_${horizon}d`,current.observedReturns/current.matured,
  previous.observedReturns/previous.matured,"observed_matured_account_return_ratio",true);
}

/** Complete grouped source distributions only. Every bucket is a stable
 * nonpersonal product reference or a constrained dimension label. A missing
 * bucket is zero only after the entire untruncated distribution is verified.
 * This is a review heuristic using observed units/visits, not causal proof. */
export type CustomerDistribution={dimension:"product"|"modifier"|"basket"|"channel"|"daypart"|"weekday";buckets:Readonly<Record<string,number>>;total:number;complete:boolean};
export function compareCustomerDistributions(current:CustomerDistribution,previous:CustomerDistribution,
 currentPeriod:CustomerPeriod,previousPeriod:CustomerPeriod):CustomerMeasure[]{
 const check=(d:CustomerDistribution)=>d.complete&&valid(d.total)&&d.total>=CUSTOMER_MONITOR_POLICY.minimumVisits&&
  Object.values(d.buckets).every(n=>valid(n)&&n>=0)&&
  Math.abs(Object.values(d.buckets).reduce((sum,n)=>sum+n,0)-d.total)<.000001;
 if(current.dimension!==previous.dimension||!comparable(currentPeriod,previousPeriod)||!check(current)||!check(previous))return [];
 const keys=new Set([...Object.keys(current.buckets),...Object.keys(previous.buckets)]);
 return [...keys].sort().flatMap(key=>{
  const m=measure(`returning_${current.dimension}_mix:${key}`,(current.buckets[key]??0)/current.total,
   (previous.buckets[key]??0)/previous.total,`observed_returning_${current.dimension}_share`,true);
  return m?[m]:[];
 });
}

/** Compare the same observation horizon and cadence-qualified denominators.
 * Counts are snapshots of observed references (lapse) or visits (reappearance);
 * never extrapolate to unnamed people. Coverage and materiality are shared
 * with other customer alerts. */
export type CustomerCadenceSample={eligible:number;flagged:number;complete:boolean};
export function compareCustomerCadence(kind:"lapse"|"reappearance",current:CustomerCadenceSample,
 previous:CustomerCadenceSample,currentPeriod:CustomerPeriod,previousPeriod:CustomerPeriod):CustomerMeasure|null{
 if(!comparable(currentPeriod,previousPeriod)||![current,previous].every(x=>x.complete&&
  count(x.eligible)&&count(x.flagged)&&x.eligible>=CUSTOMER_MONITOR_POLICY.minimumCohort&&x.flagged<=x.eligible))return null;
 return measure(kind==="lapse"?"observed_long_gap_share":"observed_reappearance_share",
  current.flagged/current.eligible,previous.flagged/previous.eligible,
  kind==="lapse"?"cadence_qualified_observed_reference_ratio":"cadence_qualified_observed_visit_ratio",true);
}

/** Transaction evidence remains useful when no stable guest identifiers exist.
 * Compare all eligible checks, never claim distinct customers or retention. */
export type AnonymousCustomerPeriod={checks:number;knownMoneyChecks:number;netCents:number|null;itemUnits:number|null;complete:boolean};
export function compareAnonymousCustomerPeriods(a:AnonymousCustomerPeriod,b:AnonymousCustomerPeriod):CustomerMeasure[]{
 if(![a,b].every(x=>x.complete&&count(x.checks)&&x.checks>=CUSTOMER_MONITOR_POLICY.minimumLinkedChecks&&count(x.knownMoneyChecks)&&x.knownMoneyChecks<=x.checks))return [];
 const out=[
  a.knownMoneyChecks===a.checks&&b.knownMoneyChecks===b.checks&&valid(a.netCents)&&valid(b.netCents)?
   measure("anonymous_check_spend",a.netCents/a.checks,b.netCents/b.checks,"recorded_cents_per_eligible_check",false,true):null,
  valid(a.itemUnits)&&valid(b.itemUnits)?measure("anonymous_items_per_check",a.itemUnits/a.checks,b.itemUnits/b.checks,"recorded_item_units_per_eligible_check"):null,
 ];
 return out.filter((x):x is CustomerMeasure=>x!==null);
}

/** A metric dependency registry for the exact monitor subjects. It is not an
 * intent router: owner chat still discovers all authorized raw fields. A
 * report must independently reproduce the incident and select a relevant
 * numeric aggregate, rather than count arbitrary customer columns as proof. */
const customerTrendDependencies:Record<string,readonly string[]>={
 observed_references:["identity_ref"],observed_first_visits:["first_observed_visit"],
 returning_visit_share:["returning_visit"],visits_per_reference:["identity_ref","period_account_visits"],
 period_net_per_reference:["period_account_net_sales_cents","net_sales_cents"],
 observed_history_value:["history_account_net_sales_cents"],
 linked_revenue_concentration:["period_account_revenue_share_squared"],
 observed_discount_participation:["data.aiCafeCustomer.discountParticipation"],
 observed_loyalty_participation:["data.aiCafeCustomer.loyaltyParticipation"],
 observed_order_duration:["order_duration_seconds","data.aiCafeCustomer.orderDurationSeconds"],
 recorded_refund_per_linked_check:["data.aiCafeCustomer.recordedRefundCents"],
 average_recipe_contribution:["historical_recipe_contribution_cents"],
 average_visit_spend:["net_sales_cents"],
 observed_long_gap_share:["observed_lapse_flag"],observed_reappearance_share:["observed_reappearance_flag"],
 anonymous_check_spend:["data.aiCafeCustomer.netSalesCents"],
 anonymous_items_per_check:["quantity","data.quantity"],
};
export function customerTrendEvidenceFields(subject:string):readonly string[]{
 if(Object.hasOwn(customerTrendDependencies,subject))return customerTrendDependencies[subject];
 if(/^observed_return_(7|30|60|90)d$/.test(subject))return [subject];
 const dimension=/^returning_(product|modifier|basket|channel|daypart|weekday)_mix:/.exec(subject)?.[1];
 if(dimension==="product")return ["product_ref"];
 if(dimension==="modifier")return ["modifier_ref"];
 if(dimension==="basket")return ["product_ref","paired_product_ref"];
 if(dimension==="channel")return ["order_channel"];
 if(dimension==="daypart")return ["local_hour"];
 if(dimension==="weekday")return ["business_weekday"];
 return [];
}
