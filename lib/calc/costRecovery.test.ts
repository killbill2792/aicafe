import { describe, expect, it } from "vitest";
import { computeCostRecovery, computeTodayContribution } from "./costRecovery";
import type { DayContribution, RecoveryBucket } from "./types";

const BUCKETS: RecoveryBucket[] = [
  { code: "rent", amountCents: 1_000, isEstimate: false },
  { code: "utilities_power", amountCents: 500, isEstimate: false },
];

describe("computeCostRecovery", () => {
  it("slips a bucket back to not-covered if a later actual day is bad enough", () => {
    const days: DayContribution[] = [
      { date: "2026-09-01", cents: 1_000, projected: false }, // rent covered
      { date: "2026-09-02", cents: -600, projected: false }, // slips back below rent's threshold
      { date: "2026-09-03", cents: 700, projected: false }, // covered again
    ];
    const result = computeCostRecovery(BUCKETS, days);
    const rent = result.buckets.find((b) => b.code === "rent")!;
    expect(rent.coveredOn).toBe("2026-09-03");
  });

  it("never un-covers a bucket once a projected day covers it", () => {
    const days: DayContribution[] = [
      { date: "2026-09-01", cents: 900, projected: false },
      { date: "2026-09-02", cents: 200, projected: true }, // projected: rent now covered
      { date: "2026-09-03", cents: -5_000, projected: true }, // a bad projected day never un-covers
    ];
    const result = computeCostRecovery(BUCKETS, days);
    const rent = result.buckets.find((b) => b.code === "rent")!;
    expect(rent.coveredOn).toBeNull(); // never covered on an ACTUAL day
    expect(rent.projectedCoveredOn).toBe("2026-09-02");
  });

  it("treats a zero-amount bucket as already covered", () => {
    const result = computeCostRecovery([{ code: "other", amountCents: 0, isEstimate: false }], [
      { date: "2026-09-01", cents: 0, projected: false },
    ]);
    expect(result.buckets[0].pctCovered).toBe(100);
    expect(result.currentBucketCode).toBeNull();
  });
});

describe("computeTodayContribution", () => {
  it("says everything today is yours once everything is covered — no cup unit involved", () => {
    const result = computeTodayContribution({ contributionCentsToday: 4_000, cumulativeBeforeToday: 1_500, buckets: BUCKETS });
    expect(result.allYours).toBe(true);
    expect(result.slices).toEqual([{ bucketCode: "yours", cents: 4_000 }]);
  });

  it("is a no-op for a business with zero sales today (no drinksCount dependency)", () => {
    const result = computeTodayContribution({ contributionCentsToday: 0, cumulativeBeforeToday: 200, buckets: BUCKETS });
    expect(result).toEqual({ slices: [], allYours: false });
  });

  it("splits today's dollars across the bucket(s) the money lands in, same sequential-fill thresholds as computeCostRecovery", () => {
    const result = computeTodayContribution({ contributionCentsToday: 700, cumulativeBeforeToday: 800, buckets: BUCKETS });
    expect(result.slices).toEqual([
      { bucketCode: "rent", cents: 200 },
      { bucketCode: "utilities_power", cents: 500 },
    ]);
    expect(result.allYours).toBe(false);
  });

  it("gives a single in-progress slice when today's money stays inside one bucket", () => {
    const result = computeTodayContribution({ contributionCentsToday: 300, cumulativeBeforeToday: 0, buckets: BUCKETS });
    expect(result.slices).toEqual([{ bucketCode: "rent", cents: 300 }]);
  });

  it("is never 'all yours' when today's contribution is negative, even with everything covered before today", () => {
    // Buckets total 1,500; cumulativeBeforeToday (2,000) already clears them, but today lost money.
    const result = computeTodayContribution({ contributionCentsToday: -600, cumulativeBeforeToday: 2_000, buckets: BUCKETS });
    expect(result.allYours).toBe(false);
    expect(result.slices).toEqual([]);
  });

  it("is never 'all yours' when today's contribution is exactly zero, even with everything covered before today", () => {
    const result = computeTodayContribution({ contributionCentsToday: 0, cumulativeBeforeToday: 2_000, buckets: BUCKETS });
    expect(result.allYours).toBe(false);
    expect(result.slices).toEqual([]);
  });

  it("is still 'all yours' when everything is covered before today AND today's contribution is genuinely positive", () => {
    const result = computeTodayContribution({ contributionCentsToday: 600, cumulativeBeforeToday: 2_000, buckets: BUCKETS });
    expect(result.allYours).toBe(true);
    expect(result.slices).toEqual([{ bucketCode: "yours", cents: 600 }]);
  });
});
