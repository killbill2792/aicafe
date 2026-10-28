import {
  avgMoneyLeftPerDrinkCents,
  dailyCostsToCoverCents,
  summarizeResolvedSoldProductCosts,
  sumCents,
  whatIfIngredientCostChange,
  whatIfOneLessPerson,
  whatIfPriceChange,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { expectedMissingCostLines } from "@/lib/expenses/expectedCosts";
import {breakEvenFor} from "@/lib/metrics/core/breakEven";
import {laborForPeriod} from "@/lib/metrics/core/labor";
import {shiftCafeDate} from "@/lib/metrics/core/clock";

// Break-even what-ifs need per-shift wage and per-drink milk data finer than the daily/28-day
// aggregates this snapshot carries. Until Staff (v1.5) and per-item recipe quantities are wired
// into the snapshot, these two constants stand in for "a typical hourly wage" and "a typical
// pour of milk per drink" — see PROGRESS.md decisions. The price what-if has no such assumption.
const ASSUMED_HOURLY_WAGE_CENTS = 1_950;
const ASSUMED_ML_MILK_PER_DRINK = 150;
const GALLON_ML = 3_785;

export function buildBreakEvenViewModel(snapshot: BusinessSnapshot) {
  const days=snapshot.last28Days.filter(d=>d.date>=shiftCafeDate(snapshot.todayDateStr,-28)&&d.date<snapshot.todayDateStr);
  const netSales = sumCents(days, (d) => d.netSalesCents);
  const breakEvenCostItems = snapshot.breakEvenProductCosts ?? snapshot.menuItems;
  const productCosts = summarizeResolvedSoldProductCosts(breakEvenCostItems);
  const ingredients = productCosts.totalCostCents;
  const cardFees = sumCents(days, (d) => d.cardFeesCents);
  const drinks = sumCents(days, (d) => d.drinksCount);

  const avgMoneyLeft = productCosts.missingProductCosts ? 0 : avgMoneyLeftPerDrinkCents(netSales, ingredients, cardFees, drinks);
  const runningPerDay = snapshot.runningCostLines.reduce((s, l) => s + l.amountCents, 0) / snapshot.daysInMonth;
  const dates=Array.from({length:28},(_,i)=>({date:shiftCafeDate(snapshot.todayDateStr,i-28)}));
  const labor=laborForPeriod(dates,days);
  const avgDailyStaffCost=labor.coveredDays>0?labor.projectedMonthlyLaborCents/28:0;
  const dailyCosts=dailyCostsToCoverCents(runningPerDay,avgDailyStaffCost);
  const shared=breakEvenFor({days,asOfDate:snapshot.todayDateStr,daysInMonth:snapshot.daysInMonth,
    monthlyBillsCents:Math.round(runningPerDay*snapshot.daysInMonth),
    monthlyStaffCents:labor.coveredDays>0?Math.round(avgDailyStaffCost*snapshot.daysInMonth):null,
    observedIngredientCents:productCosts.totalCostCents});
  const needed=shared.drinksPerDay??0;
  const missingCosts = expectedMissingCostLines(snapshot.runningCostLines);
  const missingCostLabels = missingCosts.map((line) => line.label);
  const unavailableReason=shared.drinksPerDay===null?
    (days.length===0||drinks<=0?"missing_sales" as const:"missing_costs" as const):null;

  const todayDrinks = snapshot.todayDay.drinksCount;
  const progressPct = needed > 0 && Number.isFinite(needed) ? Math.min(100, (todayDrinks / needed) * 100) : 0;

  const whatIfs = unavailableReason ? [] : [
    {
      key: "price",
      label: "Raise all prices 25¢",
      needed: whatIfPriceChange(avgMoneyLeft, 25, dailyCosts),
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
    noteKeys:[...shared.notes,...labor.notes,
      ...(missingCostLabels.length?["breakEvenBillsMissing"]:[]),
      ...(productCosts.missingProductCosts?["profitProductCostsMissing"]:[])],
    missingCostLabels,
    missingCosts,
  };
}
