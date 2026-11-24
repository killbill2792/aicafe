import type { DailyFacts, ExpenseCategoryCode } from "@/lib/calc";
import type {RunningCostLine} from "./types";
import {isExpectedCostCategory} from "@/lib/expenses/expectedCosts";
import {recurringCostMonthlyEquivalentCents} from "@/lib/expenses/recurringMonthlyTotal";

/** The fixed set of running-cost categories every business tracks, and their display labels —
 * shared between the live snapshot (snapshot.server.ts) and the month-calendar historical query
 * (monthCalendar.server.ts) so the two can never drift into different category lists. */
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

type ExpenseRow={id:string;category_code:string;amount_cents:number;status:string;spent_on:string;recurring_cost_id?:string|null};
type RecurringRow={id:string;category_code:string;amount_cents:number;frequency:string;is_estimate:boolean;active_from:string;active_to:string|null};
/** Retain actual expenses and uncovered commitments separately. Only the
 * persisted recurring-cost foreign key identifies a receipt as payment for
 * that commitment; a matching category is not evidence of settlement.
 * Ingredients are handled by the existing product/ingredient cost model. */
export function runningCostLinesForMonth(args:{
  expenses:readonly ExpenseRow[];recurring:readonly RecurringRow[];priorExpenses?:readonly {category_code:string}[];
  from:string;to:string;today:string;historical:boolean;order?:readonly string[];
}):RunningCostLine[]{
 const expenses=args.expenses.filter(e=>e.spent_on>=args.from&&e.spent_on<=args.to);
 const recurring=args.recurring.filter(r=>r.active_from<=args.to&&(!r.active_to||r.active_to>=args.from));
 // Recovery order controls presentation, not which stored costs are counted.
 const codes=[...new Set([...(args.order??[]),...RUNNING_COST_CODES,
  ...expenses.map(e=>e.category_code),...recurring.map(r=>r.category_code)])].filter(code=>code!=="ingredients");
 return codes.map(raw=>{
  const code=raw as ExpenseCategoryCode;
  const actual=expenses.filter(e=>e.category_code===code);
  const obligations=recurring.filter(r=>r.category_code===code);
  const uncovered=obligations.filter(r=>!expenses.some(e=>e.recurring_cost_id===r.id));
  const recordedExpenseCents=actual.reduce((sum,e)=>sum+Number(e.amount_cents),0);
  const recurringEstimateCents=uncovered.reduce((sum,r)=>sum+recurringCostMonthlyEquivalentCents({
   amountCents:Number(r.amount_cents),frequency:r.frequency as "monthly"|"weekly"|"quarterly"|"yearly"}),0);
  const isExpected=isExpectedCostCategory(code,{hasActiveRecurring:obligations.length>0,
   hadActualPreviousMonth:(args.priorExpenses??[]).some(e=>e.category_code===code)});
  // An unlinked receipt could overlap an uncovered bill. Retain both as
  // separate evidence; the combined forecast is uncertain, never actual cash.
  const ambiguous=uncovered.length>0&&actual.some(e=>!e.recurring_cost_id);
  return {categoryCode:code,label:RUNNING_COST_LABELS[code]??code,
   amountCents:recordedExpenseCents+recurringEstimateCents,
   recordedExpenseCents,recurringEstimateCents,
   amountSource:actual.length?(uncovered.length?"mixed":"recorded_expense"):uncovered.length?"recurring":"missing",
   actualTodayCents:actual.filter(e=>e.spent_on===args.today&&e.status==="actual").reduce((sum,e)=>sum+Number(e.amount_cents),0),
   isEstimate:actual.some(e=>e.status==="estimated")||uncovered.some(r=>r.is_estimate)||args.historical&&uncovered.length>0||ambiguous,
   isMissing:actual.length===0&&obligations.length===0&&isExpected,isExpected:isExpected||actual.length>0};
 });
}
