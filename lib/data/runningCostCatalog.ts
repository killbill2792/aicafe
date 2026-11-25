import type { DailyFacts, ExpenseCategoryCode } from "@/lib/calc";
import type {RunningCostEvidence,RunningCostLine} from "./types";
import {isExpectedCostCategory} from "@/lib/expenses/expectedCosts";
import {recurringCostMonthlyEquivalentCents} from "@/lib/expenses/recurringMonthlyTotal";

/** Legacy screen display defaults only. They do not determine which source costs are included. */
export const RUNNING_COST_CODES: ExpenseCategoryCode[] = [
  "rent",
  "utilities_power",
  "water",
  "internet",
  "insurance",
  "loan",
  "software",
  "supplies",
  "repairs",
  "other",
];

export const RUNNING_COST_LABELS: Record<string, string> = {
  rent: "Rent",
  utilities_power: "Electricity & gas",
  water: "Water",
  internet: "Internet & phone",
  insurance: "Insurance",
  loan: "Loan payment",
  software: "Software",
  supplies: "Store runs & supplies",
  repairs: "Repairs",
  other: "Other",
};

export function rowToDailyFacts(row: {
  business_date: string;
  net_sales_cents: number;
  orders_count: number;
  drinks_count: number;
  ingredients_cents: number;
  staff_wages_cents: number | null;
  staff_tax_cents: number | null;
  labor_wage_status?: "actual" | "estimate" | "missing";
  staff_tax_status?: "estimated" | "actual";
  staff_tax_source?: string;
  sales_data_status?: "actual" | "missing";
  card_fees_cents: number;
  card_fees_status?: "actual" | "estimated" | "missing";
  voids_cents: number;
}): DailyFacts {
  return {
    date: row.business_date,
    netSalesCents: row.net_sales_cents,
    ordersCount: row.orders_count,
    drinksCount: row.drinks_count,
    ingredientsCents: row.ingredients_cents,
    wagesCents: row.staff_wages_cents,
    staffTaxCents: row.staff_tax_cents,
    laborWageStatus: row.labor_wage_status ?? (row.staff_wages_cents===null?"missing":"actual"),
    staffTaxStatus: row.staff_tax_status,
    staffTaxSource: row.staff_tax_source,
    salesDataStatus: row.sales_data_status,
    cardFeesCents: row.card_fees_cents,
    cardFeesStatus: row.card_fees_status,
    voidsCents: row.voids_cents,
  };
}

type ExpenseRow={id:string;category_code:string;amount_cents:number;status:string;spent_on:string;recurring_cost_id?:string|null;custom_label?:string|null;vendor?:string|null;source?:string|null};
type RecurringRow={id:string;category_code:string;amount_cents:number;frequency:string;is_estimate:boolean;active_from:string;active_to:string|null;label?:string;due_day?:number|null;source?:string|null};
/** Retain actual expenses and uncovered commitments separately. Only the
 * persisted recurring-cost foreign key identifies a receipt as payment for
 * that commitment; a matching category is not evidence of settlement.
 * Ingredients are handled by the existing product/ingredient cost model. */
export function runningCostLinesForMonth(args:{
  expenses:readonly ExpenseRow[];recurring:readonly RecurringRow[];priorExpenses?:readonly {category_code:string}[];
  from:string;to:string;today:string;historical:boolean;order?:readonly string[];
}):RunningCostLine[]{
 const expenses=args.expenses.filter(e=>e.spent_on>=args.from&&e.spent_on<=args.to&&e.spent_on<=args.today);
 const recurring=args.recurring.filter(r=>r.active_from<=args.to&&(!r.active_to||r.active_to>=args.from));
 // Recovery order controls presentation, not which stored costs are counted.
 const codes=[...new Set([...(args.order??[]),...RUNNING_COST_CODES,
  ...(args.priorExpenses??[]).map(e=>e.category_code),...expenses.map(e=>e.category_code),...recurring.map(r=>r.category_code)])].filter(code=>code!=="ingredients");
 return codes.map(raw=>{
  const code=raw as ExpenseCategoryCode;
  const actual=expenses.filter(e=>e.category_code===code);
  const obligations=recurring.filter(r=>r.category_code===code);
  const recordedExpenseCents=actual.reduce((sum,e)=>sum+Number(e.amount_cents),0);
  const obligationEvidence=obligations.map(r=>{
   const monthlyEquivalentCents=recurringCostMonthlyEquivalentCents({
    amountCents:Number(r.amount_cents),frequency:r.frequency as "monthly"|"weekly"|"quarterly"|"yearly"});
   // A receipt linked to an obligation reduces its forecast, never all
   // obligations in its category. Several partial/weekly receipts may exist.
   const linkedRecordedCents=expenses.filter(e=>e.recurring_cost_id===r.id)
    .reduce((sum,e)=>sum+Number(e.amount_cents),0);
   return {kind:"recurring" as const,id:r.id,label:r.label??r.category_code,
    amountCents:Number(r.amount_cents),frequency:r.frequency,source:r.source??null,
    dueDay:r.due_day??null,activeFrom:r.active_from,activeTo:r.active_to,isEstimate:r.is_estimate,
    monthlyEquivalentCents,linkedRecordedCents,remainingForecastCents:Math.max(0,monthlyEquivalentCents-linkedRecordedCents),
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
   hadActualPreviousMonth:(args.priorExpenses??[]).some(e=>e.category_code===code)});
  const ambiguous=possibleAdditionalForecastCents>0;
  return {categoryCode:code,label:RUNNING_COST_LABELS[code]??code,
   amountCents:recordedExpenseCents+recurringEstimateCents,
   recordedExpenseCents,recurringEstimateCents,expenseEvidence,
   possibleAdditionalForecastCents,forecastOverlapUncertain:ambiguous,
   amountSource:actual.length?(remaining>0?"mixed":"recorded_expense"):obligations.length?"recurring":"missing",
   actualTodayCents:actual.filter(e=>e.spent_on===args.today&&e.status==="actual").reduce((sum,e)=>sum+Number(e.amount_cents),0),
   isEstimate:actual.some(e=>e.status!=="actual")||remaining>0||ambiguous,
   isMissing:actual.length===0&&obligations.length===0&&isExpected,isExpected:isExpected||actual.length>0};
 });
}
