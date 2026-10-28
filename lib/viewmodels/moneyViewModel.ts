import {
  combinedHealthBand,
  computeCostRecovery,
  ingredientsHealthBand,
  ownerProfitCentsForPeriod,
  laborKnown,
  staffCostCentsForPeriod,
  ratio,
  staffHealthBand,
  summarizeResolvedSoldProductCosts,
  sumCents,
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
import {cardFeesForDays,type OwnerFeePlan} from "@/lib/metrics/core/fees";
import {profitForPeriod} from "@/lib/metrics/core/profit";
import {laborForPeriod} from "@/lib/metrics/core/labor";
import {breakEvenFor} from "@/lib/metrics/core/breakEven";

export function buildCostRecoveryViewModel(snapshot: BusinessSnapshot) {
  const buckets = recoveryBuckets(snapshot);
  const actual = actualDayContributions(snapshot);
  const projected = snapshot.last28Days.length ? projectedDayContributions(snapshot) : [];
  const recovery = computeCostRecovery(buckets, [...actual, ...projected]);

  const totalCents = buckets.reduce((s, b) => s + b.amountCents, 0);


  const monthlyBillsCents = snapshot.runningCostLines
    .filter((line) => !line.isMissing)
    .reduce((sum, line) => sum + line.amountCents, 0);

  const monthRecordedDays = snapshot.monthRecordedDays ?? snapshot.monthActualDays;
  const missingMonthWage=monthRecordedDays.some(d=>!laborKnown(d));
  // Known contributions cannot establish final coverage when any recorded wage is partial.
  const allCovered=!missingMonthWage&&recovery.currentBucketCode===null;
  const todayDay = Number(snapshot.todayDateStr.slice(-2));
  const monthOpenDates=Array.from({length:snapshot.daysInMonth},(_,i)=>
    snapshot.monthKey+"-"+String(i+1).padStart(2,"0")).filter(date=>
      regularHoursStateForDate(snapshot.business.openHours,date)!=="closed");
  const ownerExtras=(snapshot as BusinessSnapshot&{ownerMonthlyPayrollExtrasCents?:number|null})
    .ownerMonthlyPayrollExtrasCents;
  const monthLabor=laborForPeriod(monthOpenDates.map(date=>({date})),monthRecordedDays,null,
    ownerExtras==null?null:{monthlyCents:ownerExtras,from:snapshot.monthKey+"-01",
      to:snapshot.monthKey+"-"+String(snapshot.daysInMonth).padStart(2,"0")});
  const monthlyStaffCents=monthLabor.projectedMonthlyLaborCents;

  const salesHistory = snapshot.last28Days;
  const breakEvenCostItems = snapshot.breakEvenProductCosts ?? snapshot.menuItems;
  const productCosts = summarizeResolvedSoldProductCosts(breakEvenCostItems);
  const missingProductCosts = productCosts.missingProductCosts;
  // Use the same pure sold-item product-cost aggregation as the drinks/day break-even surface.
  const missingProcessingFees = salesHistory.some((day) => day.cardFeesStatus === "missing");
  const missingBills = snapshot.runningCostLines.some((line) => line.isMissing && line.isExpected);

  const feePlans=(snapshot as BusinessSnapshot&{ownerFeePlans?:OwnerFeePlan[]}).ownerFeePlans;
  const sharedBreakEven=breakEvenFor({
    days:salesHistory,asOfDate:snapshot.todayDateStr,daysInMonth:snapshot.daysInMonth,
    monthlyBillsCents,monthlyStaffCents,
    observedIngredientCents:productCosts.totalCostCents,ownerFeePlans:feePlans,
  });
  const breakEven=sharedBreakEven.calculation;
  const breakEvenNotes=[...sharedBreakEven.notes,
    ...(missingBills?["breakEvenBillsMissing"]:[]),
    ...(missingProductCosts?["profitProductCostsMissing"]:[]),
    ...(missingProcessingFees?["profitFeesMissing"]:[]),
    ...monthLabor.notes];

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
    projectedMonthEndProfitCents:recovery.projectedMonthEndProfitCents,
    allCovered,
    totalCents,
    actualDays: actual,
    projectedDays: projected,
    monthlyBillsCents,
    monthlyStaffCents,
    breakEven,
    breakEvenNotes,
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
  const wageUnknown=recordedLaborDays.some(d=>!laborKnown(d));
  // Retain observed cents even when other wage rows are unknown; never show unknown as verified zero.
  const wagesCents=sumCents(recordedLaborDays,d=>d.wagesCents??0);
  const staffTaxCents=sumCents(recordedLaborDays,d=>d.staffTaxCents??0);
  const feePlans=(snapshot as BusinessSnapshot&{ownerFeePlans?:OwnerFeePlan[]}).ownerFeePlans;
  const feeResult=cardFeesForDays(days,feePlans??null);
  const cardFeesCents=feeResult.amountCents;
  // This is the same known-cost contract consumed by Supervisor; Money still
  // separately gates any owner-profit claim on the existing strict coverage.
  const coverage=periodCoverage(snapshot,period);
  const ownerExtras=(snapshot as BusinessSnapshot&{ownerMonthlyPayrollExtrasCents?:number|null})
    .ownerMonthlyPayrollExtrasCents;
  const baseLaborResult=laborForPeriod(
    Array.from({length:coverage.expectedDays},(_,i)=>({
      date:new Date(Date.parse(calendar.start+"T12:00:00Z")+i*86400000).toISOString().slice(0,10),
    })),recordedLaborDays);
  const laborResult=laborForPeriod(
    Array.from({length:coverage.expectedDays},(_,i)=>({
      date:new Date(Date.parse(calendar.start+"T12:00:00Z")+i*86400000).toISOString().slice(0,10),
    })),recordedLaborDays,null,ownerExtras==null?null:{
      monthlyCents:ownerExtras,from:calendar.start,to:calendar.end,
    });
  const ownerPayrollExtrasCents=laborResult.knownLaborCents-baseLaborResult.knownLaborCents;
  const feeMissing=days.some(d=>d.netSalesCents>0&&d.cardFeesStatus==="missing");
  const costMissing=businessCosts.missingInputs.filter(k=>k.startsWith("productCost:")||
    k==="itemSalesCoverage"||k==="historicalIngredientCostCoverage");
  const knownProfit=profitForPeriod(
    days,
    {amountCents:Math.round(runningCosts),
      missing:businessCosts.missingInputs.filter(k=>k.startsWith("expense:")||
        k==="priorMonthRunningCostCoverage"),estimated:businessCosts.estimatedInputs.some(k=>k.startsWith("expense:"))},
    {amountCents:cardFeesCents,missing:feeMissing?["cardFeesMissing"]:[],estimated:feeResult.basis!=="actual"},
    {amountCents:laborResult.knownLaborCents,
      missing:laborResult.coveredDays===coverage.expectedDays?[]:["laborCoveragePartial"],
      estimated:laborResult.basis!=="recorded"},
    {amountCents:ingredientsCents,missing:costMissing,
      estimated:businessCosts.estimatedInputs.some(k=>k.startsWith("productCost:"))},
  );
  const ownerProfitCents=knownProfit.profitCents;
  const totalCostsCents=knownProfit.profitCents===null?null:
    Math.round(Object.values(knownProfit.partsUsed).reduce((a,b)=>a+b,0));
  const baselineProfitDisplay=ownerProfitCents===null?{kind:"unavailable" as const}:
    ownerProfitDisplayState(ownerProfitCents,coverage);
  const ownerProfitDisplay=baselineProfitDisplay.kind==="complete"&&
      (knownProfit.basis==="partial"||businessCosts.completeness!=="complete")?
      {kind:"partial" as const,ownerProfitCents:ownerProfitCents!,tone:baselineProfitDisplay.tone}
      :baselineProfitDisplay;
  const comparisonState = periodComparisonState(coverage, previousPeriodCoverage(snapshot, period));

  const ingredientsRatio = ratio(ingredientsCents, salesCents);
  const staffRatio=wageUnknown?null:ratio(laborResult.knownLaborCents,salesCents);
  const combinedRatio=wageUnknown?null:ratio(ingredientsCents+laborResult.knownLaborCents,salesCents);

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
      rows.every(d => d.staffTaxStatus !== "estimated" && laborKnown(d));
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
        ...(currentLabor.covered && previousLabor.covered && currentLabor.costCents!==null && previousLabor.costCents!==null ? [{
          key: "staff", label: "Staff",
          deltaCents: currentLabor.costCents - previousLabor.costCents,
          lowerIsBetter: true,
        }] : []),
        ...(profitComparisonReady && ownerProfitCents!==null && ownerProfitCentsForPeriod(prevDays,prevRunningCosts)!==null ? [{
          key: "ownerProfit", label: "Owner profit",
          deltaCents: ownerProfitCents! - ownerProfitCentsForPeriod(prevDays, prevRunningCosts)!,
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
    financialNotes:[...knownProfit.notes,...laborResult.notes],
    ownerPayrollExtrasCents,
    comparisonState,
    ingredientsRatio,
    staffRatio,
    combinedRatio,
    ingredientsBand: ingredientsHealthBand(ingredientsRatio),
    staffBand: staffRatio===null?null:staffHealthBand(staffRatio),
    combinedBand: combinedRatio===null?null:combinedHealthBand(combinedRatio),
    changes,
    costsEnteredCount: enteredCount,
    costsTotalCount: snapshot.runningCostLines.length,
  };
}
