import { describe, expect, it } from "vitest";
import { computeCostRecovery } from "./costRecovery";
import { avgMoneyLeftPerDrinkCents, dailyCostsToCoverCents, drinksNeededPerDay, whatIfPriceChange } from "./breakEven";
import { rentBillsSharePerDrinkCents } from "./perDrink";
import {
  combinedHealthBand,
  ingredientsHealthBand,
  ownerProfitCentsForPeriod,
  ratio,
  staffCostCentsForPeriod,
  staffHealthBand,
  totalCostsCentsForPeriod,
} from "./profit";
import { runningCostsForPeriodCents } from "./runningCosts";
import type { DayContribution } from "./types";
import {
  FIXTURE_A_BUCKETS,
  FIXTURE_A_DAILY_CONTRIBUTION_CENTS,
  FIXTURE_A_DAY,
  FIXTURE_A_MONTH_KEY,
  FIXTURE_A_MONTHLY_RUNNING_COSTS_CENTS,
  FIXTURE_A_RUNNING_COST_PER_DAY_CENTS,
  fixtureADays,
} from "./__fixtures__/fixtureA";

function contributionDays(count: number, projected = false): DayContribution[] {
  return fixtureADays(count).map((d) => ({
    date: d.date,
    cents: FIXTURE_A_DAILY_CONTRIBUTION_CENTS,
    projected,
  }));
}

describe("Fixture A: cost recovery", () => {
  it("covers each bucket on the expected day", () => {
    const result = computeCostRecovery(FIXTURE_A_BUCKETS, contributionDays(11));
    const coveredOn = Object.fromEntries(result.buckets.map((b) => [b.code, b.coveredOn]));
    expect(coveredOn.rent).toBe("2026-09-07");
    expect(coveredOn.utilities_power).toBe("2026-09-08");
    expect(coveredOn.insurance).toBe("2026-09-09");
    expect(coveredOn.loan).toBe("2026-09-10");
    expect(coveredOn.software).toBe("2026-09-10");
    expect(coveredOn.supplies).toBe("2026-09-11");
  });

  it("reports the current bucket as of Sep 9 end of day: loan, 57.8% covered, $295.68 to go", () => {
    const result = computeCostRecovery(FIXTURE_A_BUCKETS, contributionDays(9));
    expect(result.currentBucketCode).toBe("loan");
    const loan = result.buckets.find((b) => b.code === "loan")!;
    expect(loan.pctCovered).toBeCloseTo(57.8, 1);
    expect(Math.round(loan.centsToGo)).toBe(29_568);
  });

  it("yours so far on Sep 26 is $13,812.48", () => {
    const result = computeCostRecovery(FIXTURE_A_BUCKETS, contributionDays(26));
    expect(Math.round(result.yoursSoFarCents)).toBe(1_381_248);
  });

  it("projected month-end profit for the full 30 days is $17,414.40", () => {
    const result = computeCostRecovery(FIXTURE_A_BUCKETS, contributionDays(30));
    expect(Math.round(result.projectedMonthEndProfitCents)).toBe(1_741_440);
  });
});

describe("Fixture A: owner profit", () => {
  it("month-to-date on Sep 26 is $15,092.48 (total costs $47,307.52)", () => {
    const days = fixtureADays(26);
    const runningCosts = runningCostsForPeriodCents(
      [{ categoryCode: "all", monthKey: FIXTURE_A_MONTH_KEY, amountCents: FIXTURE_A_MONTHLY_RUNNING_COSTS_CENTS, isEstimate: false, isMissing: false }],
      "2026-09-01",
      "2026-09-26",
    );
    expect(Math.round(runningCosts)).toBe(832_000); // 26 × 320.00

    expect(Math.round(totalCostsCentsForPeriod(days, runningCosts))).toBe(4_730_752);
    expect(Math.round(ownerProfitCentsForPeriod(days, runningCosts))).toBe(1_509_248);
  });

  it("today (any single day) is $580.48", () => {
    const days = fixtureADays(1);
    const runningCosts = runningCostsForPeriodCents(
      [{ categoryCode: "all", monthKey: FIXTURE_A_MONTH_KEY, amountCents: FIXTURE_A_MONTHLY_RUNNING_COSTS_CENTS, isEstimate: false, isMissing: false }],
      "2026-09-01",
      "2026-09-01",
    );
    expect(Math.round(runningCosts)).toBe(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS);
    expect(Math.round(ownerProfitCentsForPeriod(days, runningCosts))).toBe(58_048);
  });
});

describe("Fixture A: break-even", () => {
  it("average money left per drink is $3.50", () => {
    const avg = avgMoneyLeftPerDrinkCents(
      FIXTURE_A_DAY.netSalesCents,
      FIXTURE_A_DAY.ingredientsCents,
      FIXTURE_A_DAY.cardFeesCents,
      FIXTURE_A_DAY.drinks,
    );
    expect(avg).toBeCloseTo(350, 6);
  });

  it("drinks needed per day is 315", () => {
    const daily = dailyCostsToCoverCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS, FIXTURE_A_DAY.staffCostCents);
    expect(daily).toBeCloseTo(109_952, 6);
    const avg = avgMoneyLeftPerDrinkCents(
      FIXTURE_A_DAY.netSalesCents,
      FIXTURE_A_DAY.ingredientsCents,
      FIXTURE_A_DAY.cardFeesCents,
      FIXTURE_A_DAY.drinks,
    );
    expect(drinksNeededPerDay(daily, avg)).toBe(315);
  });

  it("what-if all prices +25¢ needs 294 drinks/day", () => {
    const daily = dailyCostsToCoverCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS, FIXTURE_A_DAY.staffCostCents);
    const avg = avgMoneyLeftPerDrinkCents(
      FIXTURE_A_DAY.netSalesCents,
      FIXTURE_A_DAY.ingredientsCents,
      FIXTURE_A_DAY.cardFeesCents,
      FIXTURE_A_DAY.drinks,
    );
    expect(whatIfPriceChange(avg, 25, daily)).toBe(294);
  });
});

describe("Fixture A: per-drink and health", () => {
  it("rent & bills share per drink is $0.6667", () => {
    const share = rentBillsSharePerDrinkCents(FIXTURE_A_RUNNING_COST_PER_DAY_CENTS, FIXTURE_A_DAY.drinks);
    expect(share).toBeCloseTo(66.6667, 3);
  });

  it("ingredients 27.1% healthy, staff 32.5% healthy, combined 59.6% healthy", () => {
    const days = fixtureADays(1);
    const ingredientsRatio = ratio(FIXTURE_A_DAY.ingredientsCents, FIXTURE_A_DAY.netSalesCents);
    const staffRatio = ratio(staffCostCentsForPeriod(days), FIXTURE_A_DAY.netSalesCents);
    const combinedRatio = ratio(FIXTURE_A_DAY.ingredientsCents + staffCostCentsForPeriod(days), FIXTURE_A_DAY.netSalesCents);

    expect(ingredientsRatio * 100).toBeCloseTo(27.1, 1);
    expect(staffRatio * 100).toBeCloseTo(32.5, 1);
    expect(combinedRatio * 100).toBeCloseTo(59.6, 1);

    expect(ingredientsHealthBand(ingredientsRatio)).toBe("healthy");
    expect(staffHealthBand(staffRatio)).toBe("healthy");
    expect(combinedHealthBand(combinedRatio)).toBe("healthy");
  });
});
