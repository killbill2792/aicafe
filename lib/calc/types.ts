/** Shared types for lib/calc. Money is always integer cents; intermediate math may be
 * fractional cents (see money.ts) — only round for display, per docs/05-calculations.md. */

export type ExpenseCategoryCode =
  | "rent"
  | "utilities_power"
  | "water"
  | "internet"
  | "insurance"
  | "loan"
  | "software"
  | "supplies"
  | "repairs"
  | "ingredients"
  | "other";

/** One day of a business's activity, at the granularity `daily_rollups` stores it. */
export type DailyFacts = {
  date: string; // YYYY-MM-DD, business timezone
  netSalesCents: number;
  ordersCount: number;
  drinksCount: number;
  ingredientsCents: number;
  wagesCents: number;
  staffTaxCents: number;
  cardFeesCents: number;
  voidsCents: number;
};

export type ExpenseForCategory = {
  amountCents: number;
  status: "estimated" | "actual";
};

export type RecurringForCategory = {
  amountCents: number;
  isEstimate: boolean;
};

export type CategoryMonthlyAmount = {
  categoryCode: string;
  monthKey: string; // YYYY-MM
  amountCents: number;
  isEstimate: boolean;
  /** true when the category has neither an actual entry nor a recurring estimate this month. */
  isMissing: boolean;
};

export type RecoveryBucket = {
  code: string;
  amountCents: number;
  isEstimate: boolean;
};

export type DayContribution = {
  date: string; // YYYY-MM-DD
  cents: number; // signed; a day's leftover money after ingredients/fees(/staff in per_cup mode)
  projected: boolean;
};

export type TimecardBreak = {
  start: string; // ISO timestamp
  end: string;
  paid: boolean;
};

export type Timecard = {
  clockIn: string; // ISO timestamp
  clockOut: string | null; // null = on shift now
  hourlyWageCents: number;
  breaks: TimecardBreak[];
};

export type RecipeLine = {
  ingredientId: string;
  quantity: number; // in the ingredient's base unit
};

export type ModifierDelta = {
  ingredientId: string;
  quantityDelta: number;
};

export type HealthBand = "healthy" | "watch" | "high";
