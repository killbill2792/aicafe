import type { BusinessSnapshot } from "@/lib/data/types";

/**
 * Quality label for the *new* compact Today snapshot. The legacy Home isEstimate
 * flag covers monthly running-cost estimates only; today's owner profit and total
 * costs also depend on the daily processing fee and payroll tax estimates.
 * This is presentation metadata, not a new money calculation.
 */
export function hasEstimatedTodayCosts(
  snapshot: Pick<BusinessSnapshot, "todayDay" | "runningCostLines">,
): boolean {
  return snapshot.runningCostLines.some((line) => line.isEstimate && line.amountCents > 0) ||
    snapshot.todayDay.cardFeesStatus === "estimated" ||
    snapshot.todayDay.staffTaxStatus === "estimated";
}
