import type { DailyFacts, RecoveryBucket } from "../types";

/**
 * Fixture A: demo café (docs/05-calculations.md). September 2026 (30 days), every day identical.
 * Kept exactly as written in the doc — this is what Vitest checks against, never the seeded
 * "Sunrise Café" demo data (see PROGRESS.md "Decisions made" for why the two are separate).
 */
export const FIXTURE_A_PAYROLL_TAX_RATE = 0.12;

export const FIXTURE_A_DAY = {
  netSalesCents: 240_000,
  drinks: 480,
  ingredientsCents: 65_000,
  cardFeesCents: 7_000,
  wagesCents: 69_600,
  staffTaxCents: 8_352, // 69,600 × 0.12
  staffCostCents: 77_952,
};

export const FIXTURE_A_MONTH_KEY = "2026-09";
export const FIXTURE_A_DAYS_IN_MONTH = 30;

/** rent, utilities_power, insurance, loan, software, supplies — the only categories with an
 * amount this month; water/internet/repairs/other are $0 and don't appear as buckets. */
export const FIXTURE_A_BUCKETS: RecoveryBucket[] = [
  { code: "rent", amountCents: 600_000, isEstimate: false },
  { code: "utilities_power", amountCents: 120_000, isEstimate: true },
  { code: "insurance", amountCents: 50_000, isEstimate: false },
  { code: "loan", amountCents: 70_000, isEstimate: false },
  { code: "software", amountCents: 30_000, isEstimate: false },
  { code: "supplies", amountCents: 90_000, isEstimate: false },
];

export const FIXTURE_A_MONTHLY_RUNNING_COSTS_CENTS = 960_000; // Σ buckets
export const FIXTURE_A_RUNNING_COST_PER_DAY_CENTS = 32_000; // 960,000 / 30

function dateFor(day: number): string {
  return `2026-09-${String(day).padStart(2, "0")}`;
}

export function fixtureADays(count: number): DailyFacts[] {
  return Array.from({ length: count }, (_, i) => ({
    date: dateFor(i + 1),
    netSalesCents: FIXTURE_A_DAY.netSalesCents,
    ordersCount: 0,
    drinksCount: FIXTURE_A_DAY.drinks,
    ingredientsCents: FIXTURE_A_DAY.ingredientsCents,
    wagesCents: FIXTURE_A_DAY.wagesCents,
    staffTaxCents: FIXTURE_A_DAY.staffTaxCents,
    cardFeesCents: FIXTURE_A_DAY.cardFeesCents,
    voidsCents: 0,
  }));
}

/** Per-day contribution in per_cup mode = net sales − ingredients − card fees − loaded staff. */
export const FIXTURE_A_DAILY_CONTRIBUTION_CENTS =
  FIXTURE_A_DAY.netSalesCents - FIXTURE_A_DAY.ingredientsCents - FIXTURE_A_DAY.cardFeesCents - FIXTURE_A_DAY.staffCostCents; // 90,048
