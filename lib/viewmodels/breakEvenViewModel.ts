import {
  summarizeResolvedSoldProductCosts,
  sumCents,
  whatIfIngredientCostChange,
  whatIfOneLessPerson,
  whatIfPriceChange,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { expectedMissingCostLines } from "@/lib/expenses/expectedCosts";
import {breakEvenFor,moneyLeftPerDrinkCents,dailyBreakEvenCostsCents} from "@/lib/metrics/core/breakEven";
import {cardFeesForDays,marginalCardFeeRate} from "@/lib/metrics/core/fees";
import type {OwnerFeePlan} from "@/lib/metrics/core/fees";
import {laborForPeriod} from "@/lib/metrics/core/labor";
import {shiftCafeDate} from "@/lib/metrics/core/clock";
import {regularHoursStateForDate} from "@/lib/business/openHours";

// Break-even what-ifs need per-shift wage and per-drink milk data finer than the daily/28-day
// aggregates this snapshot carries. Until Staff (v1.5) and per-item recipe quantities are wired
// into the snapshot, these two constants stand in for "a typical hourly wage" and "a typical
// pour of milk per drink" — see PROGRESS.md decisions. The price what-if has no such assumption.
const ASSUMED_HOURLY_WAGE_CENTS = 1_950;
const ASSUMED_ML_MILK_PER_DRINK = 150;
const GALLON_ML = 3_785;

/** Shared café-local period inputs for Money, Plan and Supervisor. */
export type BreakEvenPeriodMode="month_forecast"|"month_to_date"|"today";
/** Only the shared snapshot adapter may prepare break-even evidence. */
export type BreakEvenInputOptions={
 period?:BreakEvenPeriodMode;
 ingredientRateOverride?:number;
 feeRateOverride?:number;
 observedSalesCentsOverride?:number;
 monthlyLaborCentsOverride?:number;
 monthlyRentCentsOverride?:number;
 monthlyOtherOverheadCentsOverride?:number;
 openDaysOverride?:number;
};
export function breakEvenSnapshotInputs(snapshot:BusinessSnapshot,options:BreakEvenInputOptions={}) {
  const mode=options.period??"month_forecast";
  const days=(snapshot.breakEvenDays??snapshot.last28Days).filter(day=>
    day.date>=shiftCafeDate(snapshot.todayDateStr,-28)&&
    day.date<snapshot.todayDateStr&&day.salesDataStatus!=="missing");
  const costRows=snapshot.breakEvenProductCosts??snapshot.menuItems;
  const productCosts=summarizeResolvedSoldProductCosts(costRows);
  const rentLines=snapshot.runningCostLines.filter(line=>line.categoryCode==="rent"&&!line.isMissing);
  const otherLines=snapshot.runningCostLines.filter(line=>line.categoryCode!=="rent"&&!line.isMissing);
  // Owner what-ifs REPLACE only the stated component; never double-count a bill.
  const monthlyBillsCents=
    (options.monthlyRentCentsOverride??rentLines.reduce((n,row)=>n+row.amountCents,0))+
    (options.monthlyOtherOverheadCentsOverride??otherLines.reduce((n,row)=>n+row.amountCents,0));
  const openDates=Array.from({length:snapshot.daysInMonth},(_,i)=>
    snapshot.monthKey+"-"+String(i+1).padStart(2,"0")).filter(date=>
      regularHoursStateForDate(snapshot.business.openHours,date)!=="closed");
  const openDayCount=options.openDaysOverride??(openDates.length||snapshot.daysInMonth);
  const monthRecords=snapshot.monthRecordedDays??snapshot.monthActualDays;
  const closedDates=new Set(monthRecords.filter(day=>day.salesDataStatus==="actual").map(day=>day.date));
  const elapsedOpenDates=openDates.filter(date=>date<snapshot.todayDateStr||
    (date===snapshot.todayDateStr&&closedDates.has(date)));
  const elapsedDates=new Set(elapsedOpenDates);
  const elapsedLaborRecords=monthRecords.filter(day=>elapsedDates.has(day.date));
  const extras=(snapshot as BusinessSnapshot&{ownerMonthlyPayrollExtrasCents?:number|null})
    .ownerMonthlyPayrollExtrasCents;
  const monthLabor=laborForPeriod(elapsedOpenDates.map(date=>({date})),elapsedLaborRecords,null,
    extras==null?null:{monthlyCents:extras,from:snapshot.monthKey+"-01",
      to:snapshot.monthKey+"-"+String(snapshot.daysInMonth).padStart(2,"0")},
    openDayCount);
  const feePlans=(snapshot as BusinessSnapshot&{ownerFeePlans?:OwnerFeePlan[]}).ownerFeePlans;
  const feeResult=cardFeesForDays(days,feePlans??null);
  const recordedSalesCents=sumCents(days,day=>day.netSalesCents);
  const observedSalesCents=options.observedSalesCentsOverride??recordedSalesCents;
  const hasCompleteRecipeCosts=costRows.some(item=>item.quantitySoldLast28Days>0)&&
    !productCosts.missingProductCosts;
  const savedRate=snapshot.business.targetIngredientCostRate;
  const confirmedRate=typeof savedRate==="number"&&Number.isFinite(savedRate)&&savedRate>=0&&savedRate<1?
    savedRate:null;
  const ingredientSource=options.ingredientRateOverride!==undefined?"owner_override" as const:
    hasCompleteRecipeCosts?"recipe" as const:
    confirmedRate!==null?"saved_rate" as const:"partial" as const;
  const ingredientMissing=ingredientSource==="partial";
  const ingredientStatus=ingredientSource==="recipe"?"actual" as const:
    ingredientSource==="partial"?"missing" as const:
      ingredientSource==="owner_override"||snapshot.business.targetIngredientCostRateStatus==="owner"||
      snapshot.business.targetIngredientCostRateStatus==="confirmed"?"owner" as const:"estimate" as const;
  const ingredientRate=options.ingredientRateOverride??(ingredientSource==="recipe"?
    (recordedSalesCents>0?productCosts.totalCostCents/recordedSalesCents:0):confirmedRate);
  const observedIngredientCents=ingredientRate===null?productCosts.totalCostCents:
    Math.round(observedSalesCents*ingredientRate);
  const observedFeeCents=options.feeRateOverride!==undefined?
    Math.round(observedSalesCents*options.feeRateOverride):
    recordedSalesCents>0&&options.observedSalesCentsOverride!==undefined?
      Math.round(feeResult.amountCents*observedSalesCents/recordedSalesCents):
      feeResult.amountCents;
  const completeLaborDates=new Set(elapsedLaborRecords.filter(day=>
    day.wagesCents!==null&&day.staffTaxCents!==null&&day.laborWageStatus!=="missing")
    .map(day=>day.date));
  const missingLaborDates=elapsedOpenDates.filter(date=>!completeLaborDates.has(date));
  const missingBills=snapshot.runningCostLines.some(line=>
    line.isMissing&&line.isExpected&&
    !(line.categoryCode==="rent"&&options.monthlyRentCentsOverride!==undefined)&&
    !(line.categoryCode!=="rent"&&options.monthlyOtherOverheadCentsOverride!==undefined));
  const estimatedBills=snapshot.runningCostLines.some(line=>line.isEstimate&&line.amountCents>0);
  const estimatedStaffTax=monthRecords.some(day=>day.staffTaxStatus==="estimated");
  const ownerExtrasPresent=extras!=null;
  const missingFees=days.some(day=>day.cardFeesStatus==="missing");
  const monthEnd=snapshot.monthKey+"-"+String(snapshot.daysInMonth).padStart(2,"0");
  const asOf=snapshot.todayDateStr<monthEnd?snapshot.todayDateStr:monthEnd;
  const lastClosed=elapsedOpenDates.at(-1)??null;
  const mtdCalendarDays=lastClosed?Number(lastClosed.slice(-2)):0;
  const elapsedLaborCents=elapsedLaborRecords.filter(day=>completeLaborDates.has(day.date))
    .reduce((total,day)=>total+day.wagesCents!+day.staffTaxCents!,0);
  const recordedLabor=elapsedLaborCents+(extras==null?0:
    Math.round(extras*elapsedOpenDates.length/openDayCount));
  const todayRow=snapshot.todayDay;
  const todayLaborReady=todayRow.date===asOf&&todayRow.wagesCents!==null&&
    todayRow.staffTaxCents!==null&&todayRow.laborWageStatus!=="missing";
  const todayIsOpen=regularHoursStateForDate(snapshot.business.openHours,asOf)!=="closed";
  const targetOpenDays=mode==="month_forecast"?openDayCount:
    mode==="month_to_date"?elapsedOpenDates.length:todayIsOpen?1:0;
  const periodBillsCents=mode==="month_forecast"?monthlyBillsCents:
    mode==="month_to_date"?Math.round(monthlyBillsCents*mtdCalendarDays/snapshot.daysInMonth):
      Math.round(monthlyBillsCents/openDayCount);
  const periodLaborCents=options.monthlyLaborCentsOverride!==undefined?
    mode==="month_forecast"?options.monthlyLaborCentsOverride:
      mode==="month_to_date"?Math.round(options.monthlyLaborCentsOverride*
        elapsedOpenDates.length/openDayCount):
        Math.round(options.monthlyLaborCentsOverride/openDayCount):
    mode==="month_forecast"?monthLabor.projectedMonthlyLaborCents:
      mode==="month_to_date"?(elapsedOpenDates.length?recordedLabor:null):
        todayLaborReady?todayRow.wagesCents!+todayRow.staffTaxCents!+
          (extras==null?0:Math.round(extras/openDayCount)):null;
  const shared=breakEvenFor({days,asOfDate:snapshot.todayDateStr,
    daysInMonth:Math.max(1,targetOpenDays),
    monthlyBillsCents:periodBillsCents,monthlyStaffCents:periodLaborCents,
    observedIngredientCents,observedProcessingFeesCents:observedFeeCents,
    observedSalesCentsOverride:options.observedSalesCentsOverride,ownerFeePlans:feePlans});
  const forecastLabor=mode==="month_forecast"&&elapsedOpenDates.length<openDates.length;
  const periodMissingLaborDates=mode==="today"?
    (todayLaborReady?[]:[asOf]):missingLaborDates;
  const ownerBillsOverride=options.monthlyRentCentsOverride!==undefined||
    options.monthlyOtherOverheadCentsOverride!==undefined;
  const estimatesUsed=missingBills||missingFees||ingredientSource!=="recipe"||
    productCosts.usesEstimatedProductCosts||monthLabor.notes.includes("laborEstimated")||
    periodMissingLaborDates.length>0||forecastLabor||
    feeResult.basis!=="actual"||estimatedBills||estimatedStaffTax||ownerExtrasPresent||
    options.feeRateOverride!==undefined||options.ingredientRateOverride!==undefined||
    options.monthlyLaborCentsOverride!==undefined||ownerBillsOverride||
    options.observedSalesCentsOverride!==undefined;
  return {days,productCosts,monthlyBillsCents:periodBillsCents,
    monthlyStaffCents:periodLaborCents,
    monthLabor,feeResult,shared,openDayCount,targetOpenDays,openDates,elapsedOpenDates,
    missingLaborDates:periodMissingLaborDates,
    missingBills,missingFees,estimatedBills,estimatedStaffTax,ownerExtrasPresent,
    ownerBillsOverride,
    observedSalesCents,observedIngredientCents:observedIngredientCents,
    ingredientSource,ingredientStatus,ingredientMissing,estimatesUsed,
    mode,asOf,periodEnd:mode==="today"?asOf:mode==="month_to_date"?
      (lastClosed??asOf):monthEnd,forecastLabor,todayLaborReady,
    observedFeesCents:observedFeeCents,
    feeRateOverridden:options.feeRateOverride!==undefined,
    historicalFeeBasis:feeResult.basis,
    historicalActualFeeDays:feeResult.actualDays,
    historicalEstimatedFeeDays:feeResult.estimatedDays,
    payrollTaxRateStatus:snapshot.business.payrollTaxRateStatus,
  };
}

export function buildBreakEvenViewModel(snapshot: BusinessSnapshot) {
  const basis=breakEvenSnapshotInputs(snapshot);
  const {days,productCosts,shared}=basis;
  const netSales=sumCents(days,day=>day.netSalesCents);
  const ingredients=basis.observedIngredientCents;
  const drinks=sumCents(days,day=>day.drinksCount);
  const runningPerDay=basis.monthlyBillsCents/basis.openDayCount;
  const avgDailyStaffCost=basis.monthlyStaffCents===null?null:
    basis.monthlyStaffCents/basis.openDayCount;
  const dailyCosts=dailyBreakEvenCostsCents(runningPerDay,avgDailyStaffCost??0);
  const avgMoneyLeft=basis.ingredientMissing?0:moneyLeftPerDrinkCents(
    netSales,ingredients,basis.feeResult.amountCents,drinks);
  const needed=shared.drinksPerDay??0;
  const missingCosts=expectedMissingCostLines(snapshot.runningCostLines);
  const missingCostLabels=missingCosts.map(line=>line.label);
  const unavailableReason=shared.drinksPerDay===null?
    (days.length===0||drinks<=0?"missing_sales" as const:"missing_costs" as const):null;

  const todayDrinks = snapshot.todayDay.drinksCount;
  const progressPct = needed > 0 && Number.isFinite(needed) ? Math.min(100, (todayDrinks / needed) * 100) : 0;

  const whatIfs = unavailableReason ? [] : [
    {
      key: "price",
      label: "Raise all prices 25¢",
      needed: whatIfPriceChange(avgMoneyLeft, 25, dailyCosts,
        marginalCardFeeRate((snapshot as BusinessSnapshot&{ownerFeePlans?:OwnerFeePlan[]}).ownerFeePlans,snapshot.todayDateStr)),
    },
    {
      key: "staffing",
      label: "One less person 2–5 PM",
      needed: whatIfOneLessPerson(dailyCosts, avgMoneyLeft, 3, ASSUMED_HOURLY_WAGE_CENTS, snapshot.business.payrollTaxRate),
    },
    {
      key: "milk",
      label: "Milk goes up $1 a gallon",
      needed: whatIfIngredientCostChange(avgMoneyLeft, (100 / GALLON_ML) * ASSUMED_ML_MILK_PER_DRINK, dailyCosts),
    },
  ];

  return {
    breakEven:shared.calculation,
    openDaysPerMonth:basis.openDayCount,
    laborCoverage:{covered:basis.elapsedOpenDates.length-basis.missingLaborDates.length,
      total:basis.elapsedOpenDates.length,missingDates:basis.missingLaborDates},
    drinksNeededPerDay: needed,
    perHour: needed > 0 && Number.isFinite(needed) ? Math.round(needed / 12) : 0,
    todayDrinks,
    progressPct,
    runningPerDayCents: runningPerDay,
    avgDailyStaffCostCents: avgDailyStaffCost,
    avgMoneyLeftPerDrinkCents: avgMoneyLeft,
    dailyCostsToCoverCents: dailyCosts,
    whatIfs,
    unavailableReason,
    noteKeys:[...shared.notes,...basis.monthLabor.notes,
      ...(missingCostLabels.length?["breakEvenBillsMissing"]:[]),
      ...(basis.ingredientMissing?["profitProductCostsMissing"]:[])],
    missingCostLabels,
    missingCosts,
  };
}
