// Test-only legacy reference for deterministic fixture parity. Production reads SQL.
import type {ExpenseCategoryCode} from "@/lib/calc";
import type {RunningCostEvidence,RunningCostLine} from "./types";
import {RUNNING_COST_CODES,RUNNING_COST_LABELS} from "./runningCostCatalog";
import {isExpectedCostCategory} from "@/lib/expenses/expectedCosts";
import {recurringCostMonthlyEquivalentCents} from "@/lib/expenses/recurringMonthlyTotal";
type ExpenseRow={id:string;category_code:string;amount_cents:number;status:string;spent_on:string;recurring_cost_id?:string|null;custom_label?:string|null;vendor?:string|null;source?:string|null};
type RecurringRow={id:string;category_code:string;amount_cents:number;frequency:string;is_estimate:boolean;active_from:string;active_to:string|null;label?:string;due_day?:number|null;source?:string|null};
/** Retain actual expenses and uncovered commitments separately. Only the
 * persisted recurring-cost foreign key identifies a receipt as payment for
 * that commitment; a matching category is not evidence of settlement.
 * Ingredients are handled by the existing product/ingredient cost model. */
export function runningCostLinesForMonth(args:{
  expenses:readonly ExpenseRow[];recurring:readonly RecurringRow[];priorExpenses?:readonly {category_code:string;spent_on?:string;status?:string}[];
  from:string;to:string;today:string;historical:boolean;order?:readonly string[];
}):RunningCostLine[]{
 const expenses=args.expenses.filter(e=>e.spent_on>=args.from&&e.spent_on<=args.to&&e.spent_on<=args.today);
 const recurring=args.recurring.filter(r=>r.active_from<=args.to&&(!r.active_to||r.active_to>=args.from));
 const [year,month]=args.from.slice(0,7).split("-").map(Number);
 const previousMonth=month===1?String(year-1).padStart(4,"0")+"-12":String(year).padStart(4,"0")+"-"+String(month-1).padStart(2,"0");
 // Historical expectation is based on the preceding month only, not every
 // previously seen bill. An estimated entry does not prove actual payment.
 const prior=(args.priorExpenses??[]).filter(e=>
  (!e.spent_on||e.spent_on.slice(0,7)===previousMonth)&&(!e.status||e.status==="actual"));
 // Recovery order controls presentation, not which stored costs are counted.
 const codes=[...new Set([...(args.order??[]),...RUNNING_COST_CODES,
  ...prior.map(e=>e.category_code),...expenses.map(e=>e.category_code),...recurring.map(r=>r.category_code)])].filter(code=>code!=="ingredients");
 return codes.map(raw=>{
  const code=raw as ExpenseCategoryCode;
  const actual=expenses.filter(e=>e.category_code===code);
  const obligations=recurring.filter(r=>r.category_code===code);
  const recordedExpenseCents=actual.reduce((sum,e)=>sum+Number(e.amount_cents),0);
  const recordedActualCents=actual.filter(e=>e.status==="actual").reduce((sum,e)=>sum+Number(e.amount_cents),0);
  const recordedEstimatedCents=recordedExpenseCents-recordedActualCents;
  const obligationEvidence=obligations.map(r=>{
   const monthlyEquivalentCents=recurringCostMonthlyEquivalentCents({
    amountCents:Number(r.amount_cents),frequency:r.frequency as "monthly"|"weekly"|"quarterly"|"yearly"});
   // A receipt linked to an obligation reduces its forecast, never all
   // obligations in its category. Several partial/weekly receipts may exist.
   const linked=expenses.filter(e=>e.recurring_cost_id===r.id);
   const linkedRecordedCents=linked.reduce((sum,e)=>sum+Number(e.amount_cents),0);
   const linkedActualCents=linked.filter(e=>e.status==="actual").reduce((sum,e)=>sum+Number(e.amount_cents),0);
   const linkedEstimatedCents=linkedRecordedCents-linkedActualCents;
   return {kind:"recurring" as const,id:r.id,label:r.label??r.category_code,
    amountCents:Number(r.amount_cents),frequency:r.frequency,source:r.source??null,
    dueDay:r.due_day??null,activeFrom:r.active_from,activeTo:r.active_to,isEstimate:r.is_estimate,
    monthlyEquivalentCents,linkedRecordedCents,linkedActualCents,linkedEstimatedCents,remainingForecastCents:Math.max(0,monthlyEquivalentCents-linkedRecordedCents),
    costBehaviour:"unknown" as const};
  });
  const remaining=obligationEvidence.reduce((sum,r)=>sum+r.remainingForecastCents,0);
  const unlinkedRecordedCents=actual.filter(e=>!e.recurring_cost_id).reduce((sum,e)=>sum+Math.max(0,Number(e.amount_cents)),0);
  // No source proves that an unlinked receipt satisfies an obligation.
  // Keep the full candidate forecast, but use only its conservative
  // non-overlapping minimum in the combined estimate. Never report either
  // bound as a confirmed payment, fixed cost or exact total.
  const possibleAdditionalForecastCents=Math.min(remaining,unlinkedRecordedCents);
  const recurringEstimateCents=remaining-possibleAdditionalForecastCents;
  const expenseEvidence:RunningCostEvidence[]=[
   ...actual.map(e=>({kind:"expense" as const,id:e.id,label:e.custom_label??e.vendor??e.category_code,
    amountCents:Number(e.amount_cents),date:e.spent_on,status:e.status,source:e.source??null,
    recurringCostId:e.recurring_cost_id??null,costBehaviour:"unknown" as const})),
   ...obligationEvidence
  ];
  const isExpected=isExpectedCostCategory(code,{hasActiveRecurring:obligations.length>0,
   hadActualPreviousMonth:prior.some(e=>e.category_code===code)});
  const ambiguous=possibleAdditionalForecastCents>0;
  return {categoryCode:code,label:RUNNING_COST_LABELS[code]??code,
   amountCents:recordedExpenseCents+recurringEstimateCents,
   recordedExpenseCents,recordedActualCents,recordedEstimatedCents,recurringEstimateCents,expenseEvidence,
   possibleAdditionalForecastCents,forecastUpperCents:recordedExpenseCents+remaining,forecastOverlapUncertain:ambiguous,
   amountSource:actual.length?(remaining>0?"mixed":"recorded_expense"):obligations.length?"recurring":"missing",
   actualTodayCents:actual.filter(e=>e.spent_on===args.today&&e.status==="actual").reduce((sum,e)=>sum+Number(e.amount_cents),0),
   isEstimate:actual.some(e=>e.status!=="actual")||remaining>0||ambiguous,
   isMissing:actual.length===0&&obligations.length===0&&isExpected,isExpected:isExpected||actual.length>0};
 });
}


export function fixtureCostRows(seed:Record<string,unknown[]>,monthStart:string,asOf:string){
 const expenses=(seed.cv_expenses??[]) as ExpenseRow[],recurring=(seed.cv_bills??[]) as RecurringRow[];
 if(new Set(expenses.map(e=>e.id)).size!==expenses.length)throw Error("running_cost_source_incomplete");
 const to=new Date(Date.UTC(Number(monthStart.slice(0,4)),Number(monthStart.slice(5,7)),0)).toISOString().slice(0,10);
 return runningCostLinesForMonth({expenses,recurring,priorExpenses:expenses,from:monthStart,to,today:asOf,historical:false})
  .map(data=>({category_code:data.categoryCode,data}));
}
