/** Historical item-sale totals are inputs to price and ingredient what-ifs,
 * not to staff-hour savings. Keep independent staff results available even
 * when an item-sales repair link is required for the other scenarios. */
export type ScenarioHistoryBlocker = "closedDaySales" | "salesCoverageGaps" | null;

export function scenarioHistoryBlocker(
  kind: "price" | "ingredient" | "staff",
  { closedDaySales, salesCoverageGaps }: {
    closedDaySales: boolean;
    salesCoverageGaps: boolean;
  },
): ScenarioHistoryBlocker {
  if (kind === "staff") return null;
  if (closedDaySales) return "closedDaySales";
  if (salesCoverageGaps) return "salesCoverageGaps";
  return null;
}
