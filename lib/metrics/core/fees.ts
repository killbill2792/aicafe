import {hasCoveredSales} from "./salesCoverage";
/** Provider-neutral, cents-only card-processing fee calculation. No database access. */
export const DEFAULT_PROCESSING_FEE_RATE_BPS=290;
export type FeeBasis="owner_plan"|"actual"|"estimated"|"default_estimate";
export type FeeDay={
  date:string;netSalesCents:number;cardSalesCents?:number|null;
  ordersCount?:number|null;cardFeesCents?:number|null;
  cardFeesStatus?:"actual"|"estimated"|"missing";
  salesDataStatus?:"actual"|"missing";
};
export type OwnerFeePlan={
  effectiveFrom?:string;effectiveTo?:string|null;
  percentageBps?:number;fixedFeeCents?:number;
  processedSalesShareBps?:number;processedTransactionShareBps?:number;
  averageProcessedTicketCents?:number|null;
  rules?:readonly {percentageBps:number;fixedFeeCents:number;salesMixBps:number;transactionMixBps:number}[];
};
export type FeeResult={
  amountCents:number;basis:FeeBasis;actualDays:number;estimatedDays:number;
  notes:string[];
};
const valid=(value:number)=>Number.isSafeInteger(value)&&value>=0;
function planAmount(days:readonly FeeDay[],plan:OwnerFeePlan):{amountCents:number;unroundedCents:number;missingFixed:boolean}|null{
  const rules=plan.rules??[{
    percentageBps:plan.percentageBps??-1,fixedFeeCents:plan.fixedFeeCents??0,
    salesMixBps:10000,transactionMixBps:10000,
  }];
  const salesShare=plan.processedSalesShareBps??10000;
  const transactionsShare=plan.processedTransactionShareBps??10000;
  if(!valid(salesShare)||salesShare>10000||!valid(transactionsShare)||transactionsShare>10000||
    !rules.length||rules.some(r=>!valid(r.percentageBps)||!valid(r.fixedFeeCents)||
      !valid(r.salesMixBps)||r.salesMixBps>10000||!valid(r.transactionMixBps)||r.transactionMixBps>10000))return null;
  const rate=salesShare/10000*rules.reduce((sum,r)=>sum+r.percentageBps/10000*r.salesMixBps/10000,0);
  const fixed=transactionsShare/10000*rules.reduce((sum,r)=>sum+r.fixedFeeCents*r.transactionMixBps/10000,0);
  let amount=0,missingFixed=false;
  for(const d of days){
    const revenue=d.cardSalesCents??d.netSalesCents;
    let transactions=d.ordersCount??null;
    if(transactions===null&&valid(plan.averageProcessedTicketCents??-1)&&plan.averageProcessedTicketCents!>0)
      transactions=revenue/plan.averageProcessedTicketCents!;
    if(transactions===null&&fixed>0)missingFixed=true;
    amount+=revenue*rate+(transactions??0)*fixed;
  }
  return {amountCents:Math.round(amount),unroundedCents:amount,missingFixed};
}
export function cardFeesForDays(
  days:readonly FeeDay[],ownerPlan:OwnerFeePlan|readonly OwnerFeePlan[]|null=null,
):FeeResult{
  const covered=days.filter(hasCoveredSales);
  if(covered.some(d=>!valid(d.netSalesCents)||d.cardSalesCents!=null&&!valid(d.cardSalesCents)||
      d.ordersCount!=null&&!valid(d.ordersCount)))
    throw new RangeError("Invalid processing fee inputs");
  const plans:readonly OwnerFeePlan[]=ownerPlan===null?[]:
    Array.isArray(ownerPlan)?ownerPlan:[ownerPlan as OwnerFeePlan];
  const notes:string[]=[];
  let sum=0,actualDays=0,estimatedDays=0,defaultDays=0,planDays=0;
  for(const day of covered){
    // Verified fee facts from the payment provider (including actual zero
    // processing fees) have precedence over every owner estimate or plan.
    if(day.cardFeesStatus==="actual"&&day.cardFeesCents!=null&&valid(day.cardFeesCents)){
      sum+=day.cardFeesCents;
      actualDays++;
      continue;
    }
    // Per-date owner plans can change across a long historical range.
    const applicable=plans.filter(plan=>
      (!plan.effectiveFrom||plan.effectiveFrom<=day.date)&&
      (!plan.effectiveTo||plan.effectiveTo>=day.date))
      .sort((a,b)=>(b.effectiveFrom??"").localeCompare(a.effectiveFrom??""))[0];
    if(applicable){
      const amount=planAmount([day],applicable);
      if(amount&&!amount.missingFixed){
        sum+=amount.unroundedCents;planDays++;estimatedDays++;
        if(day.cardSalesCents==null)notes.push("feeNetSalesProxy");
        continue;
      }
      notes.push(amount?.missingFixed?"feeFixedTransactionCountMissing":"feeOwnerPlanInvalid");
    }
    if(day.cardFeesCents!=null&&valid(day.cardFeesCents)&&day.cardFeesStatus!=="missing"){
      // Already-persisted estimated daily facts win over the generic default.
      sum+=day.cardFeesCents;
      // Legacy complete rollups omit the status. Retain their recorded value
      // rather than retroactively labeling a stored zero an estimated fee.
      if(day.cardFeesStatus==="estimated")estimatedDays++;else actualDays++;
    }else{
      sum+=(day.cardSalesCents??day.netSalesCents)*DEFAULT_PROCESSING_FEE_RATE_BPS/10000;
      defaultDays++;
      if(day.cardSalesCents==null)notes.push("feeNetSalesProxy");
    }
  }
  if(defaultDays)notes.push("feeDefaultEstimateAskRate");
  if(plans.length&&planDays+actualDays!==covered.length)notes.push("feePlanPartialCoverage");
  if(covered.length<days.length)notes.push("feeSalesDaysMissing");
  return {amountCents:Math.round(sum),
    basis:actualDays===covered.length&&covered.length>0?"actual":
      planDays===covered.length&&planDays>0?"owner_plan":
      defaultDays===covered.length?"default_estimate":
      defaultDays||estimatedDays?"estimated":"actual",
    actualDays,estimatedDays:estimatedDays+defaultDays,notes:[...new Set(notes)]};
}
