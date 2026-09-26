import { describe, expect, it } from "vitest";
import { computeCostRecovery, computeTodayInCups } from "./costRecovery";
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

describe("computeTodayInCups", () => {
  it("says every cup is yours once everything is covered", () => {
    const result = computeTodayInCups({
      cupsToday: 200,
      contributionCentsToday: 40_000,
      cumulativeBeforeToday: 1_500,
      buckets: BUCKETS, // total 1,500
    });
    expect(result.allYours).toBe(true);
    expect(result.slices).toEqual([{ bucketCode: "yours", cups: 200, cents: 40_000 }]);
  });

  it("splits today's cups across the bucket(s) the money actually lands in", () => {
    const result = computeTodayInCups({
      cupsToday: 100,
      contributionCentsToday: 700, // cumulativeBeforeToday 800 -> 1,500: finishes rent (1,000), starts utilities
      cumulativeBeforeToday: 800,
      buckets: BUCKETS,
    });
    const rentSlice = result.slices.find((s) => s.bucketCode === "rent")!;
    const utilitiesSlice = result.slices.find((s) => s.bucketCode === "utilities_power")!;
    expect(rentSlice.cents).toBe(200); // 800 -> 1,000
    expect(utilitiesSlice.cents).toBe(500); // 1,000 -> 1,500
    expect(rentSlice.cups + utilitiesSlice.cups).toBeCloseTo(100, 6);
  });
});
