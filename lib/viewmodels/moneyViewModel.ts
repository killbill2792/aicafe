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
import { daysForPeriod, previousPeriodDays, runningCostsForDays, type Period } from "./period";

export function buildCostRecoveryViewModel(snapshot: BusinessSnapshot) {
  const buckets = recoveryBuckets(snapshot);
  const actual = actualDayContributions(snapshot);
  const projected = projectedDayContributions(snapshot);
  const recovery = computeCostRecovery(buckets, [...actual, ...projected]);

  const totalCents = buckets.reduce((s, b) => s + b.amountCents, 0);
  const allCovered = recovery.currentBucketCode === null;

  // One row per day of the month, for the calendar strip (docs/03-screens.md S4 point 3).
  const thresholds: number[] = [];
  let running = 0;
  for (const b of buckets) {
    running += b.amountCents;
    thresholds.push(running);
  }
  let cumulative = 0;
  const calendarDays = [...actual, ...projected].map((d) => {
    const before = cumulative;
    cumulative += d.cents;
    const coveredBucketCodes = buckets
      .filter((_, i) => before < thresholds[i] && cumulative >= thresholds[i])
      .map((b) => b.code);
    return {
      date: d.date,
      day: Number(d.date.slice(-2)),
      projected: d.projected,
      isYours: before >= totalCents,
      coveredBucketCodes,
    };
  });

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
    calendarDays,
    daysInMonth: snapshot.daysInMonth,
    monthKey: snapshot.monthKey,
  };
}

export function buildProfitAndCostsViewModel(snapshot: BusinessSnapshot, period: Period) {
  const days = daysForPeriod(snapshot, period);
  const runningCosts = runningCostsForDays(snapshot, days);
  const salesCents = sumCents(days, (d) => d.netSalesCents);
  const ingredientsCents = sumCents(days, (d) => d.ingredientsCents);
  const wagesCents = sumCents(days, (d) => d.wagesCents);
  const staffTaxCents = sumCents(days, (d) => d.staffTaxCents);
  const cardFeesCents = sumCents(days, (d) => d.cardFeesCents);
  const totalCostsCents = totalCostsCentsForPeriod(days, runningCosts);
  const ownerProfitCents = ownerProfitCentsForPeriod(days, runningCosts);

  const ingredientsRatio = ratio(ingredientsCents, salesCents);
  const staffRatio = ratio(wagesCents + staffTaxCents, salesCents);
  const combinedRatio = ratio(ingredientsCents + wagesCents + staffTaxCents, salesCents);

  const prevDays = previousPeriodDays(snapshot, period);
  const prevRunningCosts = runningCostsForDays(snapshot, prevDays);
  const changes = [
    { key: "sales", label: "Sales", deltaCents: salesCents - sumCents(prevDays, (d) => d.netSalesCents) },
    { key: "ingredients", label: "Ingredients", deltaCents: ingredientsCents - sumCents(prevDays, (d) => d.ingredientsCents), lowerIsBetter: true },
    { key: "staff", label: "Staff", deltaCents: wagesCents + staffTaxCents - sumCents(prevDays, (d) => d.wagesCents + d.staffTaxCents), lowerIsBetter: true },
    {
      key: "ownerProfit",
      label: "Owner profit",
      deltaCents: ownerProfitCents - ownerProfitCentsForPeriod(prevDays, prevRunningCosts),
    },
  ];

  const enteredCount = snapshot.runningCostLines.filter((l) => !l.isMissing).length;

  return {
    period,
    salesCents,
    ingredientsCents,
    wagesCents,
    staffTaxCents,
    cardFeesCents,
    runningCostLines: snapshot.runningCostLines,
    totalCostsCents,
    ownerProfitCents,
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
