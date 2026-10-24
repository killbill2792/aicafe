/** Historical item-sale totals are inputs to price and ingredient what-ifs,
 * not to staff-hour savings. Keep independent staff results available even
 * when an item-sales repair link is required for the other scenarios. */
export type ScenarioHistoryBlocker = "closedDaySales" | "salesCoverageGaps" | "insufficientSalesDays" | null;

export function scenarioHistoryBlocker(
  kind: "price" | "ingredient" | "staff",
  { closedDaySales, salesCoverageGaps, salesDaysCovered }: {
    closedDaySales: boolean;
    salesCoverageGaps: boolean;
    salesDaysCovered?: number;
  },
): ScenarioHistoryBlocker {
  if (kind === "staff") return null;
  if (closedDaySales) return "closedDaySales";
  if (salesCoverageGaps) return "salesCoverageGaps";
  if (salesDaysCovered !== undefined && salesDaysCovered < 7) return "insufficientSalesDays";
  return null;
}
