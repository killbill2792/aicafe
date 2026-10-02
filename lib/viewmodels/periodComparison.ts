export type PeriodCoverage = { actualDays: number; expectedDays: number };

export type PeriodComparisonState = { kind: "available" } | { kind: "notEnoughData" };

/**
 * Whether a "vs last period" comparison is trustworthy to show at all. Comparing a partially
 * covered current period (say, 4 of 7 days this week) against a sparse previous one (1 of 7 days
 * last week) isn't a like-for-like comparison — both sides must be *fully* covered (the same
 * "complete" bar `ownerProfitDisplayState` already uses) before any delta between them means
 * anything. This gates the whole comparison, not just the Owner Profit figure, since every
 * compared metric (sales, ingredients, staff...) suffers from the same mismatch.
 */
export function periodComparisonState(coverage: PeriodCoverage, previousCoverage: PeriodCoverage): PeriodComparisonState {
  const currentComplete = coverage.actualDays === coverage.expectedDays;
  const previousComplete = previousCoverage.actualDays === previousCoverage.expectedDays;
  return currentComplete && previousComplete ? { kind: "available" } : { kind: "notEnoughData" };
}
