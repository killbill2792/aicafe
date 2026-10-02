import type { DailyFacts } from "@/lib/calc";
import { FIXTURE_A_BUCKETS, FIXTURE_A_DAY, FIXTURE_A_PAYROLL_TAX_RATE, fixtureADays } from "@/lib/calc/__fixtures__/fixtureA";
import type { BusinessSnapshot, MenuItemSnapshot, StaffShift } from "./types";

/**
 * Dev fallback used whenever Supabase isn't connected yet (see isSupabaseConfigured()). Built
 * from Fixture A so every number on screen matches docs/05-calculations.md exactly — the
 * screens can be verified visually without a live database. Once Supabase is configured, real
 * queries (snapshot.server.ts) take over and this is never used. "Today" is Sep 9, matching
 * design/mockups/cost-recovery.html's own reference point and the doc's richest worked example
 * (current bucket = loan, 57.8% covered).
 */

// Scales revenue-side figures down for "last month" so the Home hero's vs-last-period arrow has
// something to show (a believable "up" month), matching overview.html's flavor ("8% more than
// August"). Running costs aren't scaled (see period.ts's categoryMonthlyAmounts fallback), so with
// fixed costs held flat the resulting owner-profit swing is larger than 8% — operating leverage,
// not a bug — this is presentation flavor for the fixture, not a Fixture A checked value.
const PREVIOUS_MONTH_SCALE = 1 / 1.08;

// Real calendar dates (not synthetic labels) — several lib/calc functions parse `date` to prorate
// across month boundaries, so every day here must be a valid local YYYY-MM-DD string.
function addDaysLocal(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function scaledDay(date: string, scale: number): DailyFacts {
  return {
    date,
    netSalesCents: Math.round(FIXTURE_A_DAY.netSalesCents * scale),
    ordersCount: Math.round((FIXTURE_A_DAY.drinks / 1.3) * scale),
    drinksCount: Math.round(FIXTURE_A_DAY.drinks * scale),
    ingredientsCents: Math.round(FIXTURE_A_DAY.ingredientsCents * scale),
    wagesCents: Math.round(FIXTURE_A_DAY.wagesCents * scale),
    staffTaxCents: Math.round(FIXTURE_A_DAY.staffTaxCents * scale),
    cardFeesCents: Math.round(FIXTURE_A_DAY.cardFeesCents * scale),
    voidsCents: 0,
  };
}

const MENU_ITEMS: MenuItemSnapshot[] = [
  { id: "latte", name: "Latte", priceCents: 525, prepSeconds: 90, category: "drink", ingredientsCentsToday: 95, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 3_360 },
  { id: "cappuccino", name: "Cappuccino", priceCents: 450, prepSeconds: 90, category: "drink", ingredientsCentsToday: 74, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 2_016 },
  { id: "cold_brew", name: "Cold brew", priceCents: 575, prepSeconds: 30, category: "drink", ingredientsCentsToday: 88, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 1_176 },
  { id: "mocha", name: "Mocha", priceCents: 625, prepSeconds: 105, category: "drink", ingredientsCentsToday: 137, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 1_344 },
  { id: "matcha_latte", name: "Matcha latte", priceCents: 600, prepSeconds: 120, category: "drink", ingredientsCentsToday: 186, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 672 },
  { id: "drip", name: "Drip coffee", priceCents: 325, prepSeconds: 30, category: "drink", ingredientsCentsToday: 46, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 3_024 },
  { id: "muffin", name: "Muffin", priceCents: 400, prepSeconds: 15, category: "food", ingredientsCentsToday: 208, hasRecipe: true, costStatus: "READY", quantitySoldLast28Days: 1_848 },
];

// Staff screen demo data — matches design/mockups/staff.html's own example roster (same names,
// roles, and wages) so the demo screen looks identical to the approved mockup. Pinned to
// midday (not the mockup's implied mid-morning) so the meal-break flag has something real to
// show: Ana took a qualifying break and Marco didn't, computed by lib/calc/alerts.ts's
// mealBreakStatus, not hardcoded — this is a real state, not a cosmetic flag.
// Explicit -07:00 (Pacific Daylight Time, matching the fixture business's timezone in September)
// on every timestamp — the same class of bug M2's postmortem warns about: a naive "local" string
// parses as the *server's* local time (UTC on Vercel), which would silently show "11pm" instead
// of "6am" on a server not in Pacific time. An explicit offset makes the instant unambiguous.
const STAFF_NOW_ISO = "2026-09-09T12:15:00-07:00";

const STAFF_SHIFTS_TODAY: StaffShift[] = [
  {
    employeeId: "demo-ana",
    name: "Ana",
    role: "Barista",
    timecard: {
      clockIn: "2026-09-09T06:00:00-07:00",
      clockOut: null,
      hourlyWageCents: 2200,
      breaks: [{ start: "2026-09-09T10:00:00-07:00", end: "2026-09-09T10:30:00-07:00", paid: false }],
    },
  },
  {
    employeeId: "demo-marco",
    name: "Marco",
    role: "Barista",
    timecard: {
      clockIn: "2026-09-09T07:00:00-07:00",
      clockOut: null,
      hourlyWageCents: 2100,
      breaks: [],
    },
  },
  {
    employeeId: "demo-dee",
    name: "Dee",
    role: "Register",
    timecard: {
      clockIn: "2026-09-09T08:00:00-07:00",
      clockOut: null,
      hourlyWageCents: 1900,
      breaks: [],
    },
  },
];

export function getFixtureSnapshot(): BusinessSnapshot {
  const todayDateStr = "2026-09-09";
  const monthActualDays = fixtureADays(9);
  const oneFixtureDay = fixtureADays(1)[0];
  // Ends at todayDateStr, ascending — day 27 (index 27) is "today", day 0 is 27 days earlier.
  const last28Days = Array.from({ length: 28 }, (_, i) => ({
    ...oneFixtureDay,
    date: addDaysLocal(todayDateStr, i - 27),
  }));
  const last7Days = monthActualDays.slice(-7);
  const previousMonthDays = Array.from({ length: 31 }, (_, i) => scaledDay(`2026-08-${i + 1}`, PREVIOUS_MONTH_SCALE));

  const runningCostLines = FIXTURE_A_BUCKETS.map((b) => ({
    categoryCode: b.code as BusinessSnapshot["runningCostLines"][number]["categoryCode"],
    label: RUNNING_COST_LABELS[b.code] ?? b.code,
    amountCents: b.amountCents,
    isEstimate: b.isEstimate,
    isMissing: false,
  }));

  return {
    business: { id: "fixture-a", name: "Your Café", timezone: "America/Los_Angeles", payrollTaxRate: FIXTURE_A_PAYROLL_TAX_RATE },
    todayDateStr,
    monthKey: "2026-09",
    daysInMonth: 30,
    monthActualDays,
    last28Days,
    last7Days,
    todayDay: monthActualDays[monthActualDays.length - 1],
    todayHasData: true,
    previousMonthDays,
    runningCostLines,
    recoveryOrder: FIXTURE_A_BUCKETS.map((b) => b.code),
    menuItems: MENU_ITEMS,
    alerts: { count: 0, leakingCents: 0 },
    staffShiftsToday: STAFF_SHIFTS_TODAY,
    staffNowIso: STAFF_NOW_ISO,
  };
}

const RUNNING_COST_LABELS: Record<string, string> = {
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
