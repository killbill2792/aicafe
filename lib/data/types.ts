import type { DailyFacts, ExpenseCategoryCode, Timecard } from "@/lib/calc";
import type { OpenHours } from "@/lib/business/openHours";

export type BusinessSettings = {
  id: string;
  name: string;
  timezone: string;
  payrollTaxRate: number;
  /** Current regular weekly hours for the primary location; absent means unknown/unconfigured. */
  openHours?: OpenHours | null;
};

export type RunningCostLine = {
  categoryCode: ExpenseCategoryCode;
  label: string;
  amountCents: number;
  isEstimate: boolean;
  isMissing: boolean;
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
  /** Theoretical ingredient cost at today's ingredient prices. */
  ingredientsCentsToday: number;
  /** False when there's no recipe yet, or the recipe exists but nothing on it has a priced cost —
   * ingredientsCentsToday is 0 in both cases, not because the drink is actually free to make, so
   * callers must not treat that 0 as a real cost. */
  hasRecipe: boolean;
  costStatus: "READY" | "NO_RECIPE" | "MISSING_INGREDIENT_COST";
  quantitySoldLast28Days: number;
};

export type StaffShift = {
  employeeId: string;
  name: string;
  role: string | null;
  timecard: Timecard;
};

/**
 * Everything the money screens need for one business, assembled once per request. Pure data —
 * no formulas here (see lib/calc); screens build their numbers via lib/viewmodels/*.
 */
export type BusinessSnapshot = {
  business: BusinessSettings;
  todayDateStr: string; // YYYY-MM-DD, business timezone
  monthKey: string; // YYYY-MM, current month
  daysInMonth: number;
  /** Actual days so far this month, ascending, day 1 through today. */
  monthActualDays: DailyFacts[];
  /** Last 28 actual days ending today (for effective fee rate, avg drinks/day, etc). */
  last28Days: DailyFacts[];
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
  /** This month's running-cost categories, in recovery_order, including $0/missing ones. */
  runningCostLines: RunningCostLine[];
  recoveryOrder: string[];
  menuItems: MenuItemSnapshot[];
  /** M7 wires real alert generation; both snapshot sources report zero until then. */
  alerts: { count: number; leakingCents: number };
  /** All of today's timecard rows (open and already-clocked-out), for the Staff screen. */
  staffShiftsToday: StaffShift[];
  /** The instant "on shift now" / "today so far" are computed as of — real current time in the
   * live snapshot, a pinned mid-morning time in the fixture snapshot (see fixtureSnapshot.ts). */
  staffNowIso: string;
};
