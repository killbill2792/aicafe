import {
  computeCostRecovery,
  ratio,
  roundHalfUpToCent,
  laborKnown,
  sumCents,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { actualDayContributions, recoveryBuckets } from "./costRecoveryShared";
import {
  previousPeriodCoverage,
  type Period,
} from "./period";
import { periodComparisonState } from "./periodComparison";
import { expectedMissingCostLines } from "@/lib/expenses/expectedCosts";
import {buildProfitAndCostsViewModel} from "./moneyViewModel";
import {buildBreakEvenViewModel} from "./breakEvenViewModel";
import {percentChangeFromProfitDelta} from "@/lib/metrics/core/profit";

export function buildHomeViewModel(snapshot: BusinessSnapshot, period: Period) {
  // Home is a view of the very same shared profit calculation used by Money and chat.
  const money=buildProfitAndCostsViewModel(snapshot,period);
  const salesCents=money.salesCents;
  const ownerProfitCents=money.ownerProfitCents;
  const totalCostsCents=money.totalCostsCents;
  const coverage=money.coverage;
  const ownerProfitDisplay=money.ownerProfitDisplay;
  const financialNotes=money.financialNotes;
  const isEstimate=financialNotes.length>0||
    snapshot.runningCostLines.some(line=>line.isEstimate&&line.amountCents>0);
  const operatingMargin=ownerProfitCents===null||salesCents<=0?null:
    ratio(ownerProfitCents,salesCents);
  const operatingMarginQuality=operatingMargin===null?"missing" as const:
    isEstimate?"estimated" as const:"actual" as const;
  const comparisonState = periodComparisonState(coverage, previousPeriodCoverage(snapshot, period));

  const verifiedProfitChange=money.changes.find(change=>change.key==="ownerProfit");
  // A "vs last period" comparison only means something when both this period and the comparison
  // period are fully covered — comparing 4 of 7 days this week against 1 of 7 last week (or a
  // complete today against a missing yesterday) isn't like-for-like.
  const changeVsLastPeriodPct =
    comparisonState.kind === "available" && ownerProfitCents!==null && verifiedProfitChange
      ? percentChangeFromProfitDelta(ownerProfitCents,verifiedProfitChange.deltaCents)
      : null;

  const buckets = recoveryBuckets(snapshot);
  const recovery = computeCostRecovery(buckets, actualDayContributions(snapshot));

  const today = snapshot.todayDay;

  // A missing recipe/price is unknown, not a free ingredient. Never let that unknown zero win a
  // ranking and masquerade as unusually strong contribution.
  const rankableItems = snapshot.menuItems.filter((item) => item.costStatus === "READY");
  const bestItem = [...rankableItems].sort((a, b) => keptPerCup(b) - keptPerCup(a))[0] ?? null;
  const worstItem = [...rankableItems].sort((a, b) => keptPerCup(a) - keptPerCup(b))[0] ?? null;

  const completeDays=(snapshot.breakEvenDays??snapshot.last28Days).filter(day=>day.date<snapshot.todayDateStr);
  const avgDrinksPerDay=completeDays.length?
    sumCents(completeDays,day=>day.drinksCount)/completeDays.length:0;
  const last28Net=sumCents(completeDays,day=>day.netSalesCents);
  const breakEven=buildBreakEvenViewModel(snapshot);
  const drinksNeeded=breakEven.drinksNeededPerDay;
  const staffCostToday = !laborKnown(today)?null:
    today.wagesCents+today.staffTaxCents;
  const staffCostPerMinuteNow=staffCostToday===null?null:staffCostToday/(11.5*60); // avg operating hours/day; refined once live timecards land

  const missingCategories=expectedMissingCostLines(snapshot.runningCostLines);
  const breakEvenUnavailableReason=breakEven.unavailableReason;
  // A business with zero sales in the last 28 days *and* not a single bill entered is almost
  // certainly a freshly-created café that hasn't gone through (or finished) onboarding yet, not a
  // real café having a quiet month — surface a way back in rather than a wall of $0.00 with no
  // explanation (found live: a new signup skipped onboarding and had no obvious way back).
  const hasKnownRunningCostSetup = snapshot.runningCostLines.some((line) => line.amountCents > 0 || line.isExpected === true);
  const isGettingStarted = last28Net === 0 && !hasKnownRunningCostSetup;

  return {
    period,
    coverage,
    salesCents,
    totalCostsCents,
    ownerProfitCents,
    ownerProfitDisplay,
    financialNotes,
    comparisonState,
    isEstimate,
    changeVsLastPeriodPct,
    costsRatio: totalCostsCents===null?0:ratio(totalCostsCents,salesCents),
    keepRatio: ownerProfitCents===null?0:ratio(ownerProfitCents,salesCents),
    operatingMargin,
    operatingMarginQuality,
    targetOperatingMargin: snapshot.business.targetOperatingMargin ?? 0.15,
    targetOperatingMarginStatus: snapshot.business.targetOperatingMarginStatus ?? "default",
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
