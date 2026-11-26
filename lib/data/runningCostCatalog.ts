import type { CategoryMonthlyAmount, DailyFacts, ExpenseCategoryCode } from "@/lib/calc";
import type {RunningCostLine} from "./types";

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

/** Preserve dated expense evidence and the recurring-only forecast for every
 * screen and historical consumer. Older fixtures may lack detailed evidence. */
export function runningCostMonthlyAmount(line:RunningCostLine,monthKey:string,includeEvidence=true):CategoryMonthlyAmount{
 return {categoryCode:line.categoryCode,monthKey,amountCents:line.amountCents,
  isEstimate:line.isEstimate,isMissing:line.isMissing,
  ...(includeEvidence&&line.expenseEvidence?{
    recordedExpenses:line.expenseEvidence.flatMap(e=>e.kind==="expense"?[{date:e.date,amountCents:e.amountCents,status:e.status}]:[]),
    recordedExpenseCents:line.recordedExpenseCents,
    possibleAdditionalForecastCents:line.possibleAdditionalForecastCents,
    recurringEstimateCents:line.recurringEstimateCents??0,
    recurringWindows:line.expenseEvidence.flatMap(e=>e.kind==="recurring"?[{from:e.activeFrom,to:e.activeTo??null,weightCents:e.remainingForecastCents}]:[])
  }:{})};
}
