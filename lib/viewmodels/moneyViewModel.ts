import {
  combinedHealthBand,
  computeCostRecovery,
  ingredientsHealthBand,
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
import { periodComparisonState } from "./periodComparison";
import { periodCalendarRange } from "./period";
import { businessCostSummaryFromSnapshot } from "@/lib/operating/businessCosts";
import {cardFeesForDays,type OwnerFeePlan} from "@/lib/metrics/core/fees";
import {profitForPeriod} from "@/lib/metrics/core/profit";
import {laborForPeriod,proratedOwnerPayrollExtrasCents} from "@/lib/metrics/core/labor";
import {breakEvenSnapshotInputs} from "./breakEvenViewModel";

export function buildCostRecoveryViewModel(snapshot: BusinessSnapshot) {
  const buckets = recoveryBuckets(snapshot);
  const actual = actualDayContributions(snapshot);
  const projected = snapshot.last28Days.length ? projectedDayContributions(snapshot) : [];
  const recovery = computeCostRecovery(buckets, [...actual, ...projected]);

  const totalCents = buckets.reduce((s, b) => s + b.amountCents, 0);


  const basis=breakEvenSnapshotInputs(snapshot);
  const monthlyBillsCents=basis.monthlyBillsCents;
  const monthlyStaffCents=basis.monthlyStaffCents;
  const monthRecordedDays=snapshot.monthRecordedDays??snapshot.monthActualDays;
  const missingMonthWage=monthRecordedDays.some(d=>!laborKnown(d));
  const allCovered=!missingMonthWage&&recovery.currentBucketCode===null;
  const breakEven=basis.shared.calculation;
  const breakEvenNotes=[...basis.shared.notes,
    ...(basis.missingBills?["breakEvenBillsMissing"]:[]),
    ...(basis.productCosts.missingProductCosts?["profitProductCostsMissing"]:[]),
    ...(basis.missingFees?["profitFeesMissing"]:[]),
    ...basis.monthLabor.notes];
  const breakEvenUsesEstimates=basis.estimatesUsed;

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
    observedProcessingFeesCents:basis.feeResult.amountCents,
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
  const previousFees=cardFeesForDays(prevDays,feePlans??null);
  // The owner payroll setting is a monthly extra, not clocked wages; allocate it
  // over this comparison's exact calendar dates just as the current period does.
  const previousExtrasCents=ownerExtras==null?0:proratedOwnerPayrollExtrasCents({
    monthlyCents:ownerExtras,from:prevCalendar.start,to:prevCalendar.end,
  });
  const previousProfit=profitForPeriod(prevDays,
    {amountCents:Math.round(prevRunningCosts),
      missing:previousBusinessCosts?.missingInputs.filter(k=>k.startsWith("expense:"))??["previousBillsMissing"],
      estimated:previousBusinessCosts?.estimatedInputs.some(k=>k.startsWith("expense:"))??true},
    {amountCents:previousFees.amountCents,estimated:previousFees.basis!=="actual"},
    {amountCents:previousLabor.costCents===null?null:previousLabor.costCents+previousExtrasCents,
      missing:previousLabor.covered?[]:["previousLaborMissing"],
      estimated:previousExtrasCents>0},
    {amountCents:sumCents(prevDays,d=>d.ingredientsCents),
      missing:previousBusinessCosts?.missingInputs.filter(k=>k.startsWith("productCost:")||k==="historicalIngredientCostCoverage")??["previousIngredientsMissing"],
      estimated:previousBusinessCosts?.estimatedInputs.some(k=>k.startsWith("productCost:"))??true});

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
        ...(profitComparisonReady && knownProfit.basis==="complete" &&
          previousProfit.basis==="complete" && ownerProfitCents!==null && previousProfit.profitCents!==null ? [{
          key: "ownerProfit", label: "Owner profit",
          deltaCents: ownerProfitCents - previousProfit.profitCents,
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
    financialNotes:[...new Set([...knownProfit.notes,...feeResult.notes,...laborResult.notes])],
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
