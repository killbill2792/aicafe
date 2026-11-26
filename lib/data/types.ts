import type { DailyFacts, ExpenseCategoryCode, Timecard } from "@/lib/calc";
import type { OpenHours } from "@/lib/business/openHours";

export type BusinessSettings = {
  id: string;
  name: string;
  timezone: string;
  /** Authenticated café ISO 4217 currency; null means unknown, not USD. */
  currency?: string|null;
  payrollTaxRate: number;
  payrollTaxRateStatus?: "estimated" | "confirmed";
  payrollTaxRateSource?: string;
  targetOperatingMargin?: number;
  targetOperatingMarginStatus?: "default" | "confirmed";
  /** Saved owner ingredient percentage retained when recipe evidence is incomplete. */
  targetIngredientCostRate?:number|null;
  targetIngredientCostRateStatus?:string|null;
  /** Current regular weekly hours for the primary location; absent means unknown/unconfigured. */
  openHours?: OpenHours | null;
};

/** Individual original source facts, not a category-based classification of cost behaviour. */
export type RunningCostEvidence =
 | {kind:"expense";id:string;label:string;amountCents:number;date:string;source:string|null;
    status:string;recurringCostId:string|null;costBehaviour:"unknown"}
 | {kind:"recurring";id:string;label:string;amountCents:number;frequency:string;source:string|null;
    dueDay:number|null;activeFrom:string;activeTo:string|null;isEstimate:boolean;
    monthlyEquivalentCents:number;linkedRecordedCents:number;linkedActualCents:number;linkedEstimatedCents:number;remainingForecastCents:number;
    costBehaviour:"unknown"};

export type RunningCostLine = {
  categoryCode: ExpenseCategoryCode;
  label: string;
  amountCents: number;
  /** Actual expenses already recorded this month must not be prorated as recurring bills. */
  amountSource?: "recorded_expense" | "recurring" | "mixed" | "missing";
  /** Separate observed receipts from uncovered configured monthly commitments. */
  recordedExpenseCents?:number;
  recordedActualCents?:number;
  recordedEstimatedCents?:number;
  expenseEvidence?:RunningCostEvidence[];
  /** Difference between the lower and upper forecast when overlap is unknown. */
  possibleAdditionalForecastCents?:number;
  /** Full recorded entries plus all outstanding obligations, not a certified total. */
  forecastUpperCents?:number;
  forecastOverlapUncertain?:boolean;
  recurringEstimateCents?:number;
  /** SQL-calculated fractional-cent allocation of actual receipts and active forecast by calendar date. */
  dailyAllocatedCents?:Array<{date:string;amountCents:number}>;
  isEstimate: boolean;
  isMissing: boolean;
  /** Of the actual month-to-date expenses, the amount specifically spent today. */
  actualTodayCents?:number;
  /** False when this category has no recurring row, prior actual, or other deterministic evidence
   * that this café uses it. An unused category is not a missing cost. */
  isExpected?: boolean;
};

export type MenuItemSnapshot = {
  id: string;
  name: string;
  priceCents: number;
  prepSeconds: number;
  category: "drink" | "food";
  active?: boolean;
  /** Resolved ingredient/product cost at today's known prices. */
  ingredientsCentsToday: number;
  /** False when there's no recipe yet, or the recipe exists but nothing on it has a priced cost —
   * ingredientsCentsToday is 0 in both cases, not because the drink is actually free to make, so
   * callers must not treat that 0 as a real cost. */
  hasRecipe: boolean;
  costStatus: "READY" | "NO_RECIPE" | "MISSING_INGREDIENT_COST";
  costSource?: "recipe" | "owner_total" | "combo" | null;
  recipeCostCents?: number | null;
  recipeCostStatus?: "READY" | "NO_RECIPE" | "MISSING_INGREDIENT_COST";
  ownerTotalCostCents?: number | null;
  costDifferenceCents?: number | null;
  costQuality?: "actual" | "estimated" | null;
  quantitySoldLast28Days: number;
};

export type StaffShift = {
  employeeId: string;
  name: string;
  role: string | null;
  timecard: Timecard;
  /** SQL calculated amounts; absent for synthetic/demo shifts. */
  canonicalLoadedCostCents?:number|null;
  canonicalLoadedHourlyCents?:number|null;
  canonicalDayLoadedCostCents?:number|null;
  canonicalCostAsOf?:string;
};

/**
 * Everything the money screens need for one business, assembled once per request. Pure data —
 * no formulas here (see lib/calc); screens build their numbers via lib/viewmodels/*.
 */
/** Provider-supported, period-exact canonical item participation, never a rolling window. */
export type PeriodItemSalesEvidence = {
  period:{from:string;to:string};
  covered:boolean;
  soldItems:Array<{id:string;units:number}>;
  /** Only explicit historical rollup/recipe/price reconciliation, never today's
   * costStatus, can attest that prior-date ingredient costs were complete.
   * Persisted catalog observations start at actual capture, never prove earlier
   * days retroactively; unsupported sales and missing periods stay unknown. */
  historicalIngredientCostProof?: {
    source:"historical_recomputation";
    days:Array<{date:string;ingredientsCents:number}>;
  };
};
export type CanonicalFinancialPeriod={
  netSalesCents:number;ingredientsCents:number;wagesCents:number;staffTaxCents:number;
  feesCents:number;billsCents:number;ownerPayrollExtrasCents:number;knownLaborCents:number;
  coveredSalesDays:number;coveredLaborDays:number;expectedDays:number;unknownLabor:boolean;estimatedLabor:boolean;
  totalCostsCents:number;profitCents:number|null;
};
export type FinancialPeriodKey="today"|"week"|"month"|"previous_today"|"previous_week"|"previous_month";
export type BusinessSnapshot = {
  /** Six SQL-computed screen periods; omitted only for synthetic/demo inputs. */
  financialPeriods?:Record<FinancialPeriodKey,CanonicalFinancialPeriod>;
  business: BusinessSettings;
  todayDateStr: string; // YYYY-MM-DD, business timezone
  monthKey: string; // YYYY-MM, current month
  daysInMonth: number;
  /** Every rollup row so far this month, including staff-only rows with missing sales coverage. */
  monthRecordedDays?: DailyFacts[];
  /** Sales-covered days so far this month, ascending, day 1 through today. */
  monthActualDays: DailyFacts[];
  /** Last 28 actual days ending today (for effective fee rate, avg drinks/day, etc). */
  last28Days: DailyFacts[];
  /** Sales-covered 28 COMPLETE café-local dates ending yesterday; same window as sold-item costs. */
  breakEvenDays?: DailyFacts[];
  /** Actual days whose date falls in the 7 calendar days ending today — not simply "the last 7
   * rows," which drifts from the real week the moment a day in that window has no rollup. */
  last7Days: DailyFacts[];
  /** Today's real row, or a zero day for `todayDateStr` if none exists yet — never substituted
   * with yesterday or whichever row happens to be most recently inserted. Check `todayHasData`
   * before treating its zeros as a confirmed "no sales today" rather than "not uploaded yet." */
  todayDay: DailyFacts;
  /** False when `todayDay` is a fabricated zero day — no rollup for `todayDateStr` exists yet. */
  todayHasData: boolean;
  /** Full previous calendar month, for "vs last period" comparisons. */
  previousMonthDays: DailyFacts[];
  /** Prior-month rollups including labor-only days, for cross-month Money Week. */
  previousMonthRecordedDays?: DailyFacts[];
  /** This month's running-cost categories, in recovery_order, including $0/missing ones. */
  runningCostLines: RunningCostLine[];
  previousRunningCostLines?:RunningCostLine[];
  recoveryOrder: string[];
  menuItems: MenuItemSnapshot[];
  /** Catalog cost records including archived/inactive items (not shown in active menu). */
  allCostProducts?: MenuItemSnapshot[];
  /** Explicit period-exact item-level evidence; absent means unknown, not zero. */
  periodItemSales?: PeriodItemSalesEvidence;
  /** Optional independently proven sales/cost participation for Money's comparison period.
   * Never assume current-period item evidence proves a different period. */
  comparisonPeriodItemSales?: PeriodItemSalesEvidence;
  /** Every menu item sold in the current 28-day break-even window, including archived items. */
  breakEvenProductCosts?: MenuItemSnapshot[];
  /** M7 wires real alert generation; both snapshot sources report zero until then. */
  alerts: { count: number; leakingCents: number };
  /** All of today's timecard rows (open and already-clocked-out), for the Staff screen. */
  staffShiftsToday: StaffShift[];
  /** SQL day total including archived/unlinked clock records. */
  staffCostTodayCents?:number|null;
  /** The instant "on shift now" / "today so far" are computed as of — real current time in the
   * live snapshot, a pinned mid-morning time in the fixture snapshot (see fixtureSnapshot.ts). */
  staffNowIso: string;
};
