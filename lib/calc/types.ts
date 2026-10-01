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

export type Confidence = "low" | "medium" | "high";
export type DataQuality = {
  level: Confidence;
  missingInputs: string[];
  estimatedInputs: string[];
  staleInputs: string[];
};

export type PricingCategory = import("@/lib/constants").MenuItemCategoryCode;
export type RoundingRule = { incrementCents: number; mode: "nearest" | "up" | "down" };
export type PricingProfile = {
  businessType: "COFFEE_SHOP";
  category: PricingCategory;
  targetProductCostPercent: number;
  minimumProductCostPercent: number;
  maximumProductCostPercent: number;
  minimumPriceChangePercent: number;
  minimumPriceChangeAmountCents: number;
  reviewWindowDays: number;
  roundingRule: RoundingRule;
  targetOperatingMargin: number;
  businessAdjustmentCap: number;
};
export type PricingMode = "BENCHMARK" | "BUSINESS_ADJUSTED";
export type PricingStatus = "NEW_PRICE" | "KEEP_CURRENT_PRICE" | "REVIEW_PRICE" | "PRICE_UNAVAILABLE";
export type PricingConfidence = "LOW" | "MEDIUM" | "HIGH";
export type BusinessEconomicsInput = {
  monthlyRevenueCents: number;
  monthlyVariableProductCostCents: number;
  monthlyStaffCostCents: number;
  monthlyOperatingCostCents: number;
};
export type BusinessEconomicsResult = {
  totalMonthlyCostCents: number;
  operatingSurplusCents: number;
  operatingMargin: number;
};
export type BusinessAdjustmentResult = { businessAdjustmentFactor: number; cappedForReview: boolean };
export type PosHistorySignal = {
  daysWithSalesInWindow: number;
  windowDays: number;
  totalOrdersInWindow: number;
  itemUnitsSoldInWindow: number;
  monthlyRevenueCents: number;
};
export type CategoryPeerStats = { medianPriceCents: number; medianProductCostPercent: number } | null;
export type PricingWarningCode =
  | "BUSINESS_ADJUSTMENT_CAPPED"
  | "CATEGORY_PRICE_OUTLIER"
  | "CATEGORY_COST_PERCENT_OUTLIER"
  | "INCOMPLETE_RECIPE"
  | "LOW_SAMPLE_SIZE";
/** `productCostCents`/`baselinePriceCents`/`calculatedSuggestedPriceCents`/`recommendedPriceCents`
 * are `null` exactly when `status === "PRICE_UNAVAILABLE"` — missing recipe, missing ingredient
 * cost, or a genuinely zero-cost recipe. Never read a numeric 0 as "no price"; a valid calculation
 * is guaranteed non-null and strictly positive (see suggestPrice in pricingEngine.ts). */
export type PricingResult = {
  productCostCents: number | null;
  baselinePriceCents: number | null;
  calculatedSuggestedPriceCents: number | null;
  currentPriceCents: number;
  recommendedPriceCents: number | null;
  calculationMode: PricingMode;
  businessAdjustmentFactor: number;
  confidence: PricingConfidence;
  status: PricingStatus;
  explanationCode: "BENCHMARK_EXPLAINER" | "BUSINESS_ADJUSTED_EXPLAINER" | "INCOMPLETE_DATA_EXPLAINER";
  assumptions: string[];
  signals: string[];
  explanationInputs: Record<string, number | string | boolean>;
  dataQuality: DataQuality;
  warnings: PricingWarningCode[];
};
