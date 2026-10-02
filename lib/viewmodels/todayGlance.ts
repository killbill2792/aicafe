import { averageOrderValueCents, computeCostRecovery, computeTodayContribution } from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";
import { actualDayContributions, dayContributionCents, recoveryBuckets } from "./costRecoveryShared";

/**
 * Which story today's money tells, in terms of the existing cost-recovery buckets — café, bakery
 * or restaurant alike, since none of this depends on a "cup" unit. The component picks the copy
 * and (if any) the single big icon from this, instead of a wall of per-unit icons.
 */
export type TodayGlanceBucketState =
  | { kind: "noSalesYet" }
  /** Today has a real rollup, but nothing was left over to put toward bills (a break-even or
   * negative day) — distinct from "noSalesYet" so it doesn't falsely claim nothing was uploaded. */
  | { kind: "noProgressToday" }
  | { kind: "allYours"; amountCents: number }
  | { kind: "crossed"; finishedBucketCode: string; startedBucketCode: string }
  | { kind: "inProgress"; bucketCode: string; amountCents: number; pctCoveredAfterToday: number }
  | { kind: "noBills" };

export type TodayGlanceViewModel = {
  salesCents: number;
  ordersCount: number;
  avgOrderValueCents: number;
  moneyLeftCents: number;
  drinksCount: number;
  bucketState: TodayGlanceBucketState;
};

export function buildTodayGlanceViewModel(snapshot: BusinessSnapshot): TodayGlanceViewModel {
  const today = snapshot.todayDay;
  const buckets = recoveryBuckets(snapshot);
  const contributionCentsToday = dayContributionCents(today);
  const cumulativeBeforeToday = snapshot.monthActualDays
    .filter((d) => d.date < snapshot.todayDateStr)
    .reduce((sum, d) => sum + dayContributionCents(d), 0);

  const base = {
    salesCents: today.netSalesCents,
    ordersCount: today.ordersCount,
    avgOrderValueCents: averageOrderValueCents(today.netSalesCents, today.ordersCount),
    moneyLeftCents: contributionCentsToday,
    drinksCount: today.drinksCount,
  };

  if (!snapshot.todayHasData) {
    return { ...base, bucketState: { kind: "noSalesYet" } };
  }
  if (buckets.length === 0) {
    return { ...base, bucketState: { kind: "noBills" } };
  }

  const { slices, allYours } = computeTodayContribution({ contributionCentsToday, cumulativeBeforeToday, buckets });

  if (allYours) {
    return { ...base, bucketState: { kind: "allYours", amountCents: contributionCentsToday } };
  }
  if (slices.length === 0) {
    return { ...base, bucketState: { kind: "noProgressToday" } };
  }
  if (slices.length > 1) {
    return {
      ...base,
      bucketState: {
        kind: "crossed",
        finishedBucketCode: slices[0].bucketCode,
        startedBucketCode: slices[slices.length - 1].bucketCode,
      },
    };
  }

  const slice = slices[0];
  // Reuse the canonical sequential-fill result (same one the bills list shows) for "X% covered"
  // instead of re-deriving the threshold math here, so this can never disagree with that screen.
  const recovery = computeCostRecovery(buckets, actualDayContributions(snapshot));
  const pctCoveredAfterToday = recovery.buckets.find((b) => b.code === slice.bucketCode)?.pctCovered ?? 100;

  return {
    ...base,
    bucketState: {
      kind: "inProgress",
      bucketCode: slice.bucketCode,
      amountCents: slice.cents,
      pctCoveredAfterToday: Math.max(0, Math.min(100, pctCoveredAfterToday)),
    },
  };
}
