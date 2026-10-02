import {
  avgMoneyLeftPerDrinkCents,
  computeCostRecovery,
  dailyCostsToCoverCents,
  drinksNeededPerDay,
  ownerProfitCentsForPeriod,
  ratio,
  roundHalfUpToCent,
  staffCostCentsForPeriod,
  sumCents,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { actualDayContributions, recoveryBuckets } from "./costRecoveryShared";
import {
  daysForPeriod,
  periodCoverage,
  previousPeriodCoverage,
  previousPeriodDays,
  runningCostsForPeriod,
  previousRunningCostsForPeriod,
  type Period,
} from "./period";
import { ownerProfitDisplayState } from "./ownerProfitDisplay";
import { periodComparisonState } from "./periodComparison";
import { expectedMissingCostLines } from "@/lib/expenses/expectedCosts";

export function buildHomeViewModel(snapshot: BusinessSnapshot, period: Period) {
  const days = daysForPeriod(snapshot, period);
  const runningCosts = runningCostsForPeriod(snapshot, period);
  const salesCents = sumCents(days, (d) => d.netSalesCents);
  const totalCostsCents = salesCents - ownerProfitCentsForPeriod(days, runningCosts);
  const ownerProfitCents = ownerProfitCentsForPeriod(days, runningCosts);
  const isEstimate = snapshot.runningCostLines.some((l) => l.isEstimate && l.amountCents > 0);
  const coverage = periodCoverage(snapshot, period);
  const ownerProfitDisplay = ownerProfitDisplayState(ownerProfitCents, coverage);
  const comparisonState = periodComparisonState(coverage, previousPeriodCoverage(snapshot, period));

  const prevDays = previousPeriodDays(snapshot, period);
  const prevRunningCosts = previousRunningCostsForPeriod(snapshot, period);
  const prevOwnerProfitCents = ownerProfitCentsForPeriod(prevDays, prevRunningCosts);
  // A "vs last period" comparison only means something when both this period and the comparison
  // period are fully covered — comparing 4 of 7 days this week against 1 of 7 last week (or a
  // complete today against a missing yesterday) isn't like-for-like.
  const changeVsLastPeriodPct =
    comparisonState.kind === "available" && prevOwnerProfitCents !== 0
      ? ((ownerProfitCents - prevOwnerProfitCents) / Math.abs(prevOwnerProfitCents)) * 100
      : null;

  const buckets = recoveryBuckets(snapshot);
  const recovery = computeCostRecovery(buckets, actualDayContributions(snapshot));

  const today = snapshot.todayDay;

  // A missing recipe/price is unknown, not a free ingredient. Never let that unknown zero win a
  // ranking and masquerade as unusually strong contribution.
  const rankableItems = snapshot.menuItems.filter((item) => item.costStatus === "READY");
  const bestItem = [...rankableItems].sort((a, b) => keptPerCup(b) - keptPerCup(a))[0] ?? null;
  const worstItem = [...rankableItems].sort((a, b) => keptPerCup(a) - keptPerCup(b))[0] ?? null;

  const avgDrinksPerDay = snapshot.last28Days.length
    ? sumCents(snapshot.last28Days, (d) => d.drinksCount) / snapshot.last28Days.length
    : 0;
  const last28Net = sumCents(snapshot.last28Days, (d) => d.netSalesCents);
  const last28Ingredients = sumCents(snapshot.last28Days, (d) => d.ingredientsCents);
  const last28Fees = sumCents(snapshot.last28Days, (d) => d.cardFeesCents);
  const last28Drinks = sumCents(snapshot.last28Days, (d) => d.drinksCount);
  const avgMoneyLeft = avgMoneyLeftPerDrinkCents(last28Net, last28Ingredients, last28Fees, last28Drinks);
  const avgDailyStaffCost = snapshot.last28Days.length ? staffCostCentsForPeriod(snapshot.last28Days) / snapshot.last28Days.length : 0;
  const runningPerDay = snapshot.runningCostLines.reduce((s, l) => s + l.amountCents, 0) / snapshot.daysInMonth;
  const drinksNeeded = drinksNeededPerDay(dailyCostsToCoverCents(runningPerDay, avgDailyStaffCost), avgMoneyLeft);

  const staffCostToday = today.wagesCents + today.staffTaxCents;
  const staffCostPerMinuteNow = staffCostToday / (11.5 * 60); // avg operating hours/day; refined once live timecards land

  const missingCategories = expectedMissingCostLines(snapshot.runningCostLines);
  const breakEvenUnavailableReason = missingCategories.length > 0
    ? "missing_costs" as const
    : last28Drinks <= 0 || avgMoneyLeft <= 0 || snapshot.last28Days.length === 0
      ? "missing_sales" as const
      : null;

  // A business with zero sales in the last 28 days *and* not a single bill entered is almost
  // certainly a freshly-created café that hasn't gone through (or finished) onboarding yet, not a
  // real café having a quiet month — surface a way back in rather than a wall of $0.00 with no
  // explanation (found live: a new signup skipped onboarding and had no obvious way back).
  const isGettingStarted = last28Net === 0 && missingCategories.length === snapshot.runningCostLines.length;

  return {
    period,
    coverage,
    salesCents,
    totalCostsCents,
    ownerProfitCents,
    ownerProfitDisplay,
    comparisonState,
    isEstimate,
    changeVsLastPeriodPct,
    costsRatio: ratio(totalCostsCents, salesCents),
    keepRatio: ratio(ownerProfitCents, salesCents),
    recovery,
    buckets,
    bestItem,
    worstItem,
    avgDrinksPerDay: roundHalfUpToCent(avgDrinksPerDay),
    drinksNeeded,
    breakEvenUnavailableReason,
    staffCostPerMinuteNow,
    alerts: snapshot.alerts,
    missingCategories,
    isGettingStarted,
  };
}

function keptPerCup(item: BusinessSnapshot["menuItems"][number]) {
  return item.priceCents - item.ingredientsCentsToday;
}
