import {
  calculateBreakEvenSales,
  combinedHealthBand,
  computeCostRecovery,
  ingredientsHealthBand,
  ownerProfitCentsForPeriod,
  staffCostCentsForPeriod,
  ratio,
  staffHealthBand,
  summarizeResolvedSoldProductCosts,
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
  previousPeriodCalendarRange,
  runningCostsForPeriod,
  runningCostLinesForPeriod,
  previousRunningCostsForPeriod,
  type Period,
} from "./period";
import { ownerProfitDisplayState } from "./ownerProfitDisplay";
import { regularHoursStateForDate } from "@/lib/business/openHours";
import { periodComparisonState } from "./periodComparison";
import { periodCalendarRange } from "./period";
import { businessCostSummaryFromSnapshot } from "@/lib/operating/businessCosts";

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
  const breakEvenCostItems = snapshot.breakEvenProductCosts ?? snapshot.menuItems;
  const productCosts = summarizeResolvedSoldProductCosts(breakEvenCostItems);
  const missingProductCosts = productCosts.missingProductCosts;
  // Use the same pure sold-item product-cost aggregation as the drinks/day break-even surface.
  const observedIngredientCents = productCosts.totalCostCents;
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
    salesHistory.some((day) => day.cardFeesStatus === "estimated") ||
    productCosts.usesEstimatedProductCosts;

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
  const calendar=periodCalendarRange(snapshot,period);
  const businessCosts=businessCostSummaryFromSnapshot(snapshot,{from:calendar.start,to:calendar.end});
  // Use the same canonical observed labor rows as BusinessCostSummary. A staff-only
  // rollup carries real wages even if that date lacks proved Square sales.
  const recordedLaborDays=businessCosts.completeness==="unavailable"?days:
    [
      ...(calendar.start<snapshot.monthKey+"-01"
        ? (snapshot.previousMonthRecordedDays??snapshot.previousMonthDays):[]),
      ...(snapshot.monthRecordedDays??snapshot.monthActualDays),
    ].filter(day=>day.date>=calendar.start&&day.date<=calendar.end);
  const salesCents = sumCents(days, (d) => d.netSalesCents);
  const ingredientsCents = sumCents(days, (d) => d.ingredientsCents);
  const wagesCents = sumCents(recordedLaborDays, (d) => d.wagesCents);
  const staffTaxCents = sumCents(recordedLaborDays, (d) => d.staffTaxCents);
  const cardFeesCents = sumCents(days, (d) => d.cardFeesCents);
  // This is the same known-cost contract consumed by Supervisor; Money still
  // separately gates any owner-profit claim on the existing strict coverage.
  const totalCostsCents=businessCosts.completeness==="unavailable"
    ? totalCostsCentsForPeriod(days,runningCosts) : businessCosts.knownTotalCents;
  const ownerProfitCents = ownerProfitCentsForPeriod(days, runningCosts);
  const coverage = periodCoverage(snapshot, period);
  const baselineProfitDisplay=ownerProfitDisplayState(ownerProfitCents,coverage);
  // A sales-complete period does not prove complete owner profit when costs are
  // unknown. Keep the math, but never present it as confirmed owner profit.
  const ownerProfitDisplay=businessCosts.completeness!=="complete"&&
    baselineProfitDisplay.kind==="complete"
    ? {kind:"unavailable" as const}:baselineProfitDisplay;
  const comparisonState = periodComparisonState(coverage, previousPeriodCoverage(snapshot, period));

  const ingredientsRatio = ratio(ingredientsCents, salesCents);
  const staffRatio = ratio(wagesCents + staffTaxCents, salesCents);
  const combinedRatio = ratio(ingredientsCents + wagesCents + staffTaxCents, salesCents);

  const prevDays = previousPeriodDays(snapshot, period);
  const prevRunningCosts = previousRunningCostsForPeriod(snapshot, period);
  const prevCalendar = previousPeriodCalendarRange(snapshot, period);
  // Sales coverage is not cost coverage. The prior period MUST independently
  // pass the same canonical BusinessCostSummary contract as the current one;
  // never reuse today's recipe/participation evidence for an earlier window.
  const previousBusinessCosts = comparisonState.kind === "available"
    ? businessCostSummaryFromSnapshot(
        { ...snapshot, periodItemSales: snapshot.comparisonPeriodItemSales },
        { from: prevCalendar.start, to: prevCalendar.end },
      )
    : null;
  const profitComparisonReady =
    ownerProfitDisplay.kind === "complete" &&
    businessCosts.completeness === "complete" &&
    previousBusinessCosts?.completeness === "complete";

  const ingredientCovered = (summary: typeof businessCosts) =>
    summary.coverage.salesDays === summary.coverage.expectedDays &&
    summary.coverage.itemSalesCovered &&
    summary.coverage.historicalIngredientCostsProven &&
    summary.coverage.missingProductCostCount === 0 &&
    summary.coverage.estimatedProductCostCount === 0;
  const ingredientsComparisonReady =
    ingredientCovered(businessCosts) &&
    previousBusinessCosts !== null &&
    ingredientCovered(previousBusinessCosts);

  // Staff coverage is independent of ingredient and operating-cost coverage:
  // require a recorded wage/tax row on EVERY date on BOTH sides, and no
  // estimated payroll taxes, before showing a verified staff-cost change.
  const laborRows = [
    ...(snapshot.previousMonthRecordedDays ?? snapshot.previousMonthDays),
    ...(snapshot.monthRecordedDays ?? snapshot.monthActualDays),
  ];
  const observedLabor = (range: { start: string; end: string }) => {
    const rows = laborRows.filter(d => d.date >= range.start && d.date <= range.end);
    const expected = Math.round(
      (Date.parse(range.end + "T12:00:00Z") - Date.parse(range.start + "T12:00:00Z")) /
      86_400_000,
    ) + 1;
    const covered = new Set(rows.map(d => d.date)).size === expected &&
      rows.length === expected &&
      rows.every(d => d.staffTaxStatus !== "estimated");
    return { covered, costCents: staffCostCentsForPeriod(rows) };
  };
  const currentLabor = observedLabor(calendar);
  const previousLabor = observedLabor(prevCalendar);

  // Each row has its own evidence gate. Verified sales comparisons survive
  // missing ingredient/operating costs; profit never leaks from calendar coverage.
  const changes = comparisonState.kind === "available"
    ? [
        { key: "sales", label: "Sales",
          deltaCents: salesCents - sumCents(prevDays, d => d.netSalesCents) },
        ...(ingredientsComparisonReady ? [{
          key: "ingredients", label: "Ingredients",
          deltaCents: ingredientsCents - sumCents(prevDays, d => d.ingredientsCents),
          lowerIsBetter: true,
        }] : []),
        ...(currentLabor.covered && previousLabor.covered ? [{
          key: "staff", label: "Staff",
          deltaCents: currentLabor.costCents - previousLabor.costCents,
          lowerIsBetter: true,
        }] : []),
        ...(profitComparisonReady ? [{
          key: "ownerProfit", label: "Owner profit",
          deltaCents: ownerProfitCents - ownerProfitCentsForPeriod(prevDays, prevRunningCosts),
        }] : []),
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
    businessCosts,
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
