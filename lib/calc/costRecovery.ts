import { clamp } from "./money";
import type { DayContribution, RecoveryBucket } from "./types";

export type BucketResult = {
  code: string;
  amountCents: number;
  isEstimate: boolean;
  pctCovered: number; // 0-100, as of the last actual day
  centsToGo: number;
  coveredOn: string | null; // actual date this bucket first became fully covered
  projectedCoveredOn: string | null; // forecast date, only set once the actual-day cover never happened
};

export type CostRecoveryResult = {
  buckets: BucketResult[];
  currentBucketCode: string | null; // first bucket not fully covered as of the last actual day
  yoursSoFarCents: number;
  projectedMonthEndProfitCents: number;
};

/**
 * Sequential fill: each day's leftover money fills the buckets in order (docs/05-calculations.md
 * "Cost recovery"). `days` must be sorted actual-first (chronological), then projected days.
 * A bucket's actual cover date can "slip back" to null if a later actual day drops the running
 * total back below its threshold; a projected cover date never does (mirrors the reference algorithm).
 */
export function computeCostRecovery(buckets: RecoveryBucket[], days: DayContribution[]): CostRecoveryResult {
  const thresholds: number[] = [];
  let runningThreshold = 0;
  for (const b of buckets) {
    runningThreshold += b.amountCents;
    thresholds.push(runningThreshold);
  }
  const totalCents = runningThreshold;

  const coveredOn: (string | null)[] = buckets.map(() => null);
  const projectedCoveredOn: (string | null)[] = buckets.map(() => null);

  let cumulative = 0;
  let actualCumulativeEnd = 0;

  for (const day of days) {
    cumulative += day.cents;
    if (!day.projected) actualCumulativeEnd = cumulative;

    thresholds.forEach((threshold, i) => {
      if (day.projected) {
        if (projectedCoveredOn[i] === null && cumulative >= threshold) {
          projectedCoveredOn[i] = day.date;
        }
        return;
      }
      if (coveredOn[i] === null && cumulative >= threshold) {
        coveredOn[i] = day.date;
      }
      if (coveredOn[i] !== null && cumulative < threshold) {
        coveredOn[i] = null; // slipped back
      }
    });
  }

  const finalCumulative = cumulative;

  const bucketResults: BucketResult[] = buckets.map((bucket, i) => {
    const bucketStart = i === 0 ? 0 : thresholds[i - 1];
    const filled = clamp(actualCumulativeEnd - bucketStart, 0, bucket.amountCents);
    const pctCovered = bucket.amountCents === 0 ? 100 : (filled / bucket.amountCents) * 100;
    return {
      code: bucket.code,
      amountCents: bucket.amountCents,
      isEstimate: bucket.isEstimate,
      pctCovered,
      centsToGo: bucket.amountCents - filled,
      coveredOn: coveredOn[i],
      projectedCoveredOn: coveredOn[i] ? null : projectedCoveredOn[i],
    };
  });

  const currentBucket = bucketResults.find((b) => b.pctCovered < 100) ?? null;

  return {
    buckets: bucketResults,
    currentBucketCode: currentBucket?.code ?? null,
    yoursSoFarCents: Math.max(0, actualCumulativeEnd - totalCents),
    projectedMonthEndProfitCents: finalCumulative - totalCents,
  };
}

export type TodayCupsSlice = { bucketCode: string; cups: number; cents: number };

/**
 * Splits today's cups across whichever bucket(s) today's money landed in. `cumulativeBeforeToday`
 * is the running total through yesterday; 1 cup ≈ contributionCentsToday / cupsToday.
 */
export function computeTodayInCups(params: {
  cupsToday: number;
  contributionCentsToday: number;
  cumulativeBeforeToday: number;
  buckets: RecoveryBucket[];
}): { slices: TodayCupsSlice[]; allYours: boolean } {
  const { cupsToday, contributionCentsToday, cumulativeBeforeToday, buckets } = params;

  const thresholds: number[] = [];
  let running = 0;
  for (const b of buckets) {
    running += b.amountCents;
    thresholds.push(running);
  }
  const totalCents = running;

  if (cumulativeBeforeToday >= totalCents) {
    return { slices: [{ bucketCode: "yours", cups: cupsToday, cents: contributionCentsToday }], allYours: true };
  }
  if (cupsToday === 0 || contributionCentsToday === 0) {
    return { slices: [], allYours: false };
  }

  const centsPerCup = contributionCentsToday / cupsToday;
  const slices: TodayCupsSlice[] = [];
  const todayEnd = cumulativeBeforeToday + contributionCentsToday;

  buckets.forEach((bucket, i) => {
    const bucketStart = i === 0 ? 0 : thresholds[i - 1];
    const bucketEnd = thresholds[i];
    const sliceStart = Math.max(cumulativeBeforeToday, bucketStart);
    const sliceEnd = Math.min(todayEnd, bucketEnd);
    if (sliceEnd > sliceStart) {
      const sliceCents = sliceEnd - sliceStart;
      slices.push({ bucketCode: bucket.code, cups: sliceCents / centsPerCup, cents: sliceCents });
    }
  });

  if (todayEnd > totalCents) {
    const yoursCents = todayEnd - Math.max(totalCents, cumulativeBeforeToday);
    if (yoursCents > 0) {
      slices.push({ bucketCode: "yours", cups: yoursCents / centsPerCup, cents: yoursCents });
    }
  }

  return { slices, allYours: false };
}
