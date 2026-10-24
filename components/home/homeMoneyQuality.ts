import type { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import type { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";

/**
 * Reuse Money's canonical cost evidence rather than treating recorded sales
 * coverage as proof that the business has entered every expense.
 * Presentation only: no cost or profit arithmetic here.
 */
export function homeMoneyQuality(
  home: Pick<ReturnType<typeof buildHomeViewModel>, "coverage" | "changeVsLastPeriodPct" | "missingCategories">,
  money: Pick<ReturnType<typeof buildProfitAndCostsViewModel>, "businessCosts" | "ownerProfitDisplay" | "changes">,
) {
  const costCompleteness = money.businessCosts.completeness;
  // Older cost lines may lack an explicit isExpected flag. Home still identifies
  // them as missing; do not show a verified profit while an expected bill is absent.
  const missingBills = home.missingCategories.length > 0;
  const canShowProfit = costCompleteness === "complete" && !missingBills &&
    money.ownerProfitDisplay.kind !== "unavailable";
  return {
    costCompleteness,
    canShowProfit,
    hasPartial: home.coverage.actualDays < home.coverage.expectedDays || costCompleteness === "partial" || missingBills,
    hasEstimatedCosts: money.businessCosts.estimatedInputs.length > 0,
    // Revenue coverage is insufficient to justify a *profit* comparison.
    // Both windows require independently verified costs.
    profitChangePct: canShowProfit && money.changes.some(change => change.key === "ownerProfit")
      ? home.changeVsLastPeriodPct : null,
  };
}
