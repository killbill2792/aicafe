import {
  calculateBreakEvenSales,
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
import { regularHoursStateForDate } from "@/lib/business/openHours";
import { periodComparisonState } from "./periodComparison";

function countOperatingDays(snapshot: BusinessSnapshot, throughDay: number): number {
    let count = 0;
  for (let day = 1; day <= throughDay; day++) {
    const date = `${snapshot.monthKey}-${String(day).padStart(2, "0")}`;
    if (regularHoursStateForDate(snapshot.business.openHours, date) !== "closed") count += 1;
  }
  return count;
}

export function buildCostRecoveryViewModel(snapshot: BusinessSnapshot) {
  const buckets = recoveryBuckets(snapshot);
  const actual = actualDayContributions(snapshot);
  const projected = snapshot.last28Days.length >= 7 ? projectedDayContributions(snapshot) : [];
  const recovery = computeCostRecovery(buckets, [...actual, ...projected]);

  const totalCents = buckets.reduce((s, b) => s + b.amountCents, 0);
  const allCovered = recovery.currentBucketCode === null;

  const monthlyBillsCents = snapshot.runningCostLines
    .filter((line) => !line.isMissing)
    .reduce((sum, line) => sum + line.amountCents, 0);

  const monthRecordedDays = snapshot.monthRecordedDays ?? snapshot.monthActualDays;
  const staffSoFarCents = monthRecordedDays.reduce(
    (sum, day) => sum + day.wagesCents + day.staffTaxCents,
    0,
  );
  const todayDay = Number(snapshot.todayDateStr.slice(-2));
  const elapsedOperatingDays = countOperatingDays(snapshot, todayDay);
  const fullMonthOperatingDays = countOperatingDays(snapshot, snapshot.daysInMonth);
  const monthlyStaffCents =
    elapsedOperatingDays > 0
      ? Math.round(staffSoFarCents * (fullMonthOperatingDays / elapsedOperatingDays))
      : 0;

  const salesHistory = snapshot.last28Days;
  const observedSalesCents = sumCents(salesHistory, (day) => day.netSalesCents);
  const missingProductCosts = snapshot.menuItems.some(
    (item) => item.quantitySoldLast28Days > 0 && item.costStatus !== "READY",
  );
  // Use the same resolved sold-item cost as Menu/Pricing/Simulator. Recipe-only rollups would
  // undercount a café that legitimately uses an owner-total fallback.
  const observedIngredientCents = Math.round(snapshot.menuItems.reduce(
    (sum, item) => sum + (item.costStatus === "READY" ? item.ingredientsCentsToday * item.quantitySoldLast28Days : 0),
    0,
  ));
  const observedProcessingFeesCents = sumCents(salesHistory, (day) => day.cardFeesCents);
  const missingProcessingFees = salesHistory.some((day) => day.cardFeesStatus === "missing");
  const missingBills = snapshot.runningCostLines.some((line) => line.isMissing && line.isExpected);
  const enoughSales = salesHistory.length >= 7;

  const calculatedBreakEven =
    enoughSales && !missingProductCosts && !missingProcessingFees && !missingBills
      ? calculateBreakEvenSales({
          monthlyBillsCents,
          monthlyStaffCents,
          observedSalesCents,
          observedIngredientCents,
          observedProcessingFeesCents,
        })
      : null;

  const breakEven =
    !enoughSales
      ? { kind: "unavailable" as const, reason: "NOT_ENOUGH_SALES" as const }
      : missingBills
        ? { kind: "unavailable" as const, reason: "MISSING_BILLS" as const }
        : missingProductCosts
          ? { kind: "unavailable" as const, reason: "MISSING_PRODUCT_COSTS" as const }
          : missingProcessingFees
            ? { kind: "unavailable" as const, reason: "MISSING_PROCESSING_FEES" as const }
            : calculatedBreakEven?.kind === "ready"
              ? calculatedBreakEven
              : { kind: "unavailable" as const, reason: "VARIABLE_COSTS_TOO_HIGH" as const };

  const breakEvenUsesEstimates =
    todayDay < snapshot.daysInMonth ||
    snapshot.runningCostLines.some((line) => line.isEstimate && line.amountCents > 0) ||
    monthRecordedDays.some((day) => day.staffTaxStatus === "estimated") ||
    salesHistory.some((day) => day.cardFeesStatus === "estimated");

  return {
    buckets: recovery.buckets,
    currentBucketCode: recovery.currentBucketCode,
    yoursSoFarCents: recovery.yoursSoFarCents,
    projectedMonthEndProfitCents: recovery.projectedMonthEndProfitCents,
    allCovered,
    totalCents,
    actualDays: actual,
    projectedDays: projected,
    monthlyBillsCents,
    monthlyStaffCents,
    breakEven,
    breakEvenUsesEstimates,
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
