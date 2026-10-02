import {
  combinedHealthBand,
  computeCostRecovery,
  ingredientsHealthBand,
  ownerProfitCentsForPeriod,
  ratio,
  staffHealthBand,
  sumCents,
  totalCostsCentsForPeriod,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { actualDayContributions, projectedDayContributions, recoveryBuckets } from "./costRecoveryShared";
import {
  daysForPeriod,
  periodCoverage,
  previousPeriodCoverage,
  previousPeriodDays,
  runningCostsForPeriod,
  runningCostLinesForPeriod,
  previousRunningCostsForPeriod,
  type Period,
} from "./period";
import { ownerProfitDisplayState } from "./ownerProfitDisplay";
import { periodComparisonState } from "./periodComparison";

export function buildCostRecoveryViewModel(snapshot: BusinessSnapshot) {
  const buckets = recoveryBuckets(snapshot);
  const actual = actualDayContributions(snapshot);
  const projected = projectedDayContributions(snapshot);
  const recovery = computeCostRecovery(buckets, [...actual, ...projected]);

  const totalCents = buckets.reduce((s, b) => s + b.amountCents, 0);
  const allCovered = recovery.currentBucketCode === null;

  return {
    buckets: recovery.buckets,
    currentBucketCode: recovery.currentBucketCode,
    yoursSoFarCents: recovery.yoursSoFarCents,
    // "cumulative including projected days − Σ all buckets" (docs/05-calculations.md) — what's
    // left in the owner's pocket after bills, not total revenue.
    projectedMonthEndProfitCents: recovery.projectedMonthEndProfitCents,
    allCovered,
    totalCents,
    actualDays: actual,
    projectedDays: projected,
  };
}

export function buildProfitAndCostsViewModel(snapshot: BusinessSnapshot, period: Period) {
  const days = daysForPeriod(snapshot, period);
  const runningCosts = runningCostsForPeriod(snapshot, period);
  const salesCents = sumCents(days, (d) => d.netSalesCents);
  const ingredientsCents = sumCents(days, (d) => d.ingredientsCents);
  const wagesCents = sumCents(days, (d) => d.wagesCents);
  const staffTaxCents = sumCents(days, (d) => d.staffTaxCents);
  const cardFeesCents = sumCents(days, (d) => d.cardFeesCents);
  const totalCostsCents = totalCostsCentsForPeriod(days, runningCosts);
  const ownerProfitCents = ownerProfitCentsForPeriod(days, runningCosts);
  const coverage = periodCoverage(snapshot, period);
  const ownerProfitDisplay = ownerProfitDisplayState(ownerProfitCents, coverage);
  const comparisonState = periodComparisonState(coverage, previousPeriodCoverage(snapshot, period));

  const ingredientsRatio = ratio(ingredientsCents, salesCents);
  const staffRatio = ratio(wagesCents + staffTaxCents, salesCents);
  const combinedRatio = ratio(ingredientsCents + wagesCents + staffTaxCents, salesCents);

  const prevDays = previousPeriodDays(snapshot, period);
  const prevRunningCosts = previousRunningCostsForPeriod(snapshot, period);
  // Every "vs last period" row compares the same two periods, so if either side isn't fully
  // covered none of them are trustworthy — not just the owner-profit row.
  const changes =
    comparisonState.kind === "available"
      ? [
          { key: "sales", label: "Sales", deltaCents: salesCents - sumCents(prevDays, (d) => d.netSalesCents) },
          { key: "ingredients", label: "Ingredients", deltaCents: ingredientsCents - sumCents(prevDays, (d) => d.ingredientsCents), lowerIsBetter: true },
          {
            key: "staff",
            label: "Staff",
            deltaCents: wagesCents + staffTaxCents - sumCents(prevDays, (d) => d.wagesCents + d.staffTaxCents),
            lowerIsBetter: true,
          },
          { key: "ownerProfit", label: "Owner profit", deltaCents: ownerProfitCents - ownerProfitCentsForPeriod(prevDays, prevRunningCosts) },
        ]
      : [];

  const enteredCount = snapshot.runningCostLines.filter((l) => !l.isMissing).length;

  return {
    period,
    coverage,
    salesCents,
    ingredientsCents,
    wagesCents,
    staffTaxCents,
    cardFeesCents,
    runningCostLines: runningCostLinesForPeriod(snapshot, period),
    totalCostsCents,
    ownerProfitCents,
    ownerProfitDisplay,
    comparisonState,
    ingredientsRatio,
    staffRatio,
    combinedRatio,
    ingredientsBand: ingredientsHealthBand(ingredientsRatio),
    staffBand: staffHealthBand(staffRatio),
    combinedBand: combinedHealthBand(combinedRatio),
    changes,
    costsEnteredCount: enteredCount,
    costsTotalCount: snapshot.runningCostLines.length,
  };
}
