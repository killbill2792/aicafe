import {
  avgMoneyLeftPerDrinkCents,
  computeCostRecovery,
  computeTodayInCups,
  dailyCostsToCoverCents,
  drinksNeededPerDay,
  ownerProfitCentsForPeriod,
  ratio,
  roundHalfUpToCent,
  staffCostCentsForPeriod,
  sumCents,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { actualDayContributions, dayContributionCents, recoveryBuckets } from "./costRecoveryShared";
import { daysForPeriod, previousPeriodDays, runningCostsForDays, type Period } from "./period";

export function buildHomeViewModel(snapshot: BusinessSnapshot, period: Period) {
  const days = daysForPeriod(snapshot, period);
  const runningCosts = runningCostsForDays(snapshot, days);
  const salesCents = sumCents(days, (d) => d.netSalesCents);
  const totalCostsCents = salesCents - ownerProfitCentsForPeriod(days, runningCosts);
  const ownerProfitCents = ownerProfitCentsForPeriod(days, runningCosts);
  const isEstimate = snapshot.runningCostLines.some((l) => l.isEstimate && l.amountCents > 0);

  const prevDays = previousPeriodDays(snapshot, period);
  const prevRunningCosts = runningCostsForDays(snapshot, prevDays);
  const prevOwnerProfitCents = prevDays.length > 0 ? ownerProfitCentsForPeriod(prevDays, prevRunningCosts) : 0;
  const changeVsLastPeriodPct =
    prevOwnerProfitCents !== 0 ? ((ownerProfitCents - prevOwnerProfitCents) / Math.abs(prevOwnerProfitCents)) * 100 : null;

  const buckets = recoveryBuckets(snapshot);
  const recovery = computeCostRecovery(buckets, actualDayContributions(snapshot));

  const today = snapshot.latestDay;
  const todayInCups = computeTodayInCups({
    cupsToday: today.drinksCount,
    contributionCentsToday: dayContributionCents(today),
    cumulativeBeforeToday: cumulativeThrough(snapshot, snapshot.monthActualDays.length - 2),
    buckets,
  });

  const bestItem = [...snapshot.menuItems].sort((a, b) => keptPerCup(b) - keptPerCup(a))[0] ?? null;
  const worstItem = [...snapshot.menuItems].sort((a, b) => keptPerCup(a) - keptPerCup(b))[0] ?? null;

  const avgDrinksPerDay = snapshot.last28Days.length
    ? sumCents(snapshot.last28Days, (d) => d.drinksCount) / snapshot.last28Days.length
    : 0;
  const last28Net = sumCents(snapshot.last28Days, (d) => d.netSalesCents);
  const last28Ingredients = sumCents(snapshot.last28Days, (d) => d.ingredientsCents);
  const last28Fees = sumCents(snapshot.last28Days, (d) => d.cardFeesCents);
  const avgMoneyLeft = avgMoneyLeftPerDrinkCents(last28Net, last28Ingredients, last28Fees, sumCents(snapshot.last28Days, (d) => d.drinksCount));
  const avgDailyStaffCost = snapshot.last28Days.length ? staffCostCentsForPeriod(snapshot.last28Days) / snapshot.last28Days.length : 0;
  const runningPerDay = snapshot.runningCostLines.reduce((s, l) => s + l.amountCents, 0) / snapshot.daysInMonth;
  const drinksNeeded = drinksNeededPerDay(dailyCostsToCoverCents(runningPerDay, avgDailyStaffCost), avgMoneyLeft);

  const staffCostToday = today.wagesCents + today.staffTaxCents;
  const staffCostPerMinuteNow = staffCostToday / (11.5 * 60); // avg operating hours/day; refined once live timecards land

  const missingCategories = snapshot.runningCostLines.filter((l) => l.isMissing);

  // A business with zero sales in the last 28 days *and* not a single bill entered is almost
  // certainly a freshly-created café that hasn't gone through (or finished) onboarding yet, not a
  // real café having a quiet month — surface a way back in rather than a wall of $0.00 with no
  // explanation (found live: a new signup skipped onboarding and had no obvious way back).
  const isGettingStarted = last28Net === 0 && missingCategories.length === snapshot.runningCostLines.length;

  return {
    period,
    salesCents,
    totalCostsCents,
    ownerProfitCents,
    isEstimate,
    changeVsLastPeriodPct,
    costsRatio: ratio(totalCostsCents, salesCents),
    keepRatio: ratio(ownerProfitCents, salesCents),
    recovery,
    buckets,
    todayInCups,
    bestItem,
    worstItem,
    avgDrinksPerDay: roundHalfUpToCent(avgDrinksPerDay),
    drinksNeeded,
    staffCostPerMinuteNow,
    alerts: snapshot.alerts,
    missingCategories,
    isGettingStarted,
  };
}

function keptPerCup(item: BusinessSnapshot["menuItems"][number]) {
  return item.priceCents - item.ingredientsCentsToday;
}

function cumulativeThrough(snapshot: BusinessSnapshot, throughIndex: number): number {
  const days = actualDayContributions(snapshot).slice(0, throughIndex + 1);
  return days.reduce((sum, d) => sum + d.cents, 0);
}
