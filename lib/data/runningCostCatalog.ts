import type { DailyFacts, ExpenseCategoryCode } from "@/lib/calc";

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
  staff_wages_cents: number;
  staff_tax_cents: number;
  card_fees_cents: number;
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
    cardFeesCents: row.card_fees_cents,
    voidsCents: row.voids_cents,
  };
}
