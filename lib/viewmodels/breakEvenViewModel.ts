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
export function breakEvenSnapshotInputs(snapshot:BusinessSnapshot) {
  const days=(snapshot.breakEvenDays??snapshot.last28Days).filter(day=>
    day.date>=shiftCafeDate(snapshot.todayDateStr,-28)&&
    day.date<snapshot.todayDateStr&&day.salesDataStatus!=="missing");
  const costRows=snapshot.breakEvenProductCosts??snapshot.menuItems;
  const productCosts=summarizeResolvedSoldProductCosts(costRows);
  const monthlyBillsCents=snapshot.runningCostLines.filter(line=>!line.isMissing)
    .reduce((total,line)=>total+line.amountCents,0);
  const openDates=Array.from({length:snapshot.daysInMonth},(_,i)=>
    snapshot.monthKey+"-"+String(i+1).padStart(2,"0")).filter(date=>
      regularHoursStateForDate(snapshot.business.openHours,date)!=="closed");
  const monthRecords=snapshot.monthRecordedDays??snapshot.monthActualDays;
  const closedDates=new Set(monthRecords.filter(day=>day.salesDataStatus==="actual").map(day=>day.date));
  const elapsedOpenDates=openDates.filter(date=>date<snapshot.todayDateStr||
    (date===snapshot.todayDateStr&&closedDates.has(date)));
  const elapsedDates=new Set(elapsedOpenDates);
  const elapsedLaborRecords=monthRecords.filter(day=>elapsedDates.has(day.date));
  const extras=(snapshot as BusinessSnapshot&{ownerMonthlyPayrollExtrasCents?:number|null})
    .ownerMonthlyPayrollExtrasCents;
  const monthLabor=laborForPeriod(openDates.map(date=>({date})),elapsedLaborRecords,null,
    extras==null?null:{monthlyCents:extras,from:snapshot.monthKey+"-01",
      to:snapshot.monthKey+"-"+String(snapshot.daysInMonth).padStart(2,"0")});
  const feePlans=(snapshot as BusinessSnapshot&{ownerFeePlans?:OwnerFeePlan[]}).ownerFeePlans;
  const feeResult=cardFeesForDays(days,feePlans??null);
  const observedSalesCents=sumCents(days,day=>day.netSalesCents);
  const hasCompleteRecipeCosts=costRows.some(item=>item.quantitySoldLast28Days>0)&&
    !productCosts.missingProductCosts;
  const savedRate=snapshot.business.targetIngredientCostRate;
  const confirmedRate=typeof savedRate==="number"&&Number.isFinite(savedRate)&&savedRate>=0&&savedRate<1?
    savedRate:null;
  const ingredientSource=hasCompleteRecipeCosts?"recipe" as const:
    confirmedRate!==null?"saved_rate" as const:"partial" as const;
  const ingredientMissing=ingredientSource==="partial";
  const observedIngredientCents=ingredientSource==="saved_rate"?
    Math.round(observedSalesCents*confirmedRate!):productCosts.totalCostCents;
  const openDayCount=openDates.length||snapshot.daysInMonth;
  const shared=breakEvenFor({days,asOfDate:snapshot.todayDateStr,daysInMonth:openDayCount,
    monthlyBillsCents,monthlyStaffCents:monthLabor.projectedMonthlyLaborCents,
    observedIngredientCents,ownerFeePlans:feePlans});
  const completeLaborDates=new Set(elapsedLaborRecords.filter(day=>
    day.wagesCents!==null&&day.staffTaxCents!==null&&day.laborWageStatus!=="missing")
    .map(day=>day.date));
  const missingLaborDates=elapsedOpenDates.filter(date=>!completeLaborDates.has(date));
  const missingBills=snapshot.runningCostLines.some(line=>line.isMissing&&line.isExpected);
  const estimatedBills=snapshot.runningCostLines.some(line=>line.isEstimate&&line.amountCents>0);
  const estimatedStaffTax=monthRecords.some(day=>day.staffTaxStatus==="estimated");
  const ownerExtrasPresent=extras!=null;
  const missingFees=days.some(day=>day.cardFeesStatus==="missing");
  const estimatesUsed=missingBills||missingFees||ingredientSource!=="recipe"||
    productCosts.usesEstimatedProductCosts||monthLabor.notes.includes("laborEstimated")||
    missingLaborDates.length>0||elapsedOpenDates.length<openDates.length||
    feeResult.basis!=="actual"||estimatedBills||estimatedStaffTax||ownerExtrasPresent;
  return {days,productCosts,monthlyBillsCents,monthlyStaffCents:monthLabor.projectedMonthlyLaborCents,
    monthLabor,feeResult,shared,openDayCount,openDates,elapsedOpenDates,missingLaborDates,
    missingBills,missingFees,estimatedBills,estimatedStaffTax,ownerExtrasPresent,observedSalesCents,
    observedIngredientCents,ingredientSource,ingredientMissing,estimatesUsed};
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
