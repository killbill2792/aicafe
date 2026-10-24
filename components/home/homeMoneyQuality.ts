import type { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import type { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";

/**
 * Reuse Money's canonical cost evidence rather than treating recorded sales
 * coverage as proof that the business has entered every expense.
 * Presentation only: no cost or profit arithmetic here.
 */
export function homeMoneyQuality(
  home: Pick<ReturnType<typeof buildHomeViewModel>, "coverage" | "changeVsLastPeriodPct">,
  money: Pick<ReturnType<typeof buildProfitAndCostsViewModel>, "businessCosts" | "ownerProfitDisplay" | "changes">,
) {
  const costCompleteness = money.businessCosts.completeness;
  return {
    costCompleteness,
    canShowProfit: costCompleteness === "complete" && money.ownerProfitDisplay.kind !== "unavailable",
    hasPartial: home.coverage.actualDays < home.coverage.expectedDays || costCompleteness === "partial",
    hasEstimatedCosts: money.businessCosts.estimatedInputs.length > 0,
    // Revenue coverage is insufficient to justify a *profit* comparison.
    // Both windows require independently verified costs.
    profitChangePct: money.changes.some(change => change.key === "ownerProfit")
      ? home.changeVsLastPeriodPct : null,
  };
}
