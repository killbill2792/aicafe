import type { RecipeCostStatus } from "./ingredients";

export type ResolvedSoldProductCostLine = {
  quantitySoldLast28Days: number;
  ingredientsCentsToday: number;
  costStatus: RecipeCostStatus;
  costQuality?: "actual" | "estimated" | null;
};

export type ResolvedSoldProductCostSummary = {
  totalCostCents: number;
  missingProductCosts: boolean;
  usesEstimatedProductCosts: boolean;
};

/**
 * Canonical aggregation for sold-item product costs used by every break-even surface.
 * Costs are multiplied at full precision and rounded only once at the aggregate boundary.
 */
export function summarizeResolvedSoldProductCosts(
  lines: ResolvedSoldProductCostLine[],
): ResolvedSoldProductCostSummary {
  let rawCostCents = 0;
  let missingProductCosts = false;
  let usesEstimatedProductCosts = false;

  for (const line of lines) {
    const quantity = Number(line.quantitySoldLast28Days);
    if (!(quantity > 0)) continue;
    if (line.costStatus !== "READY" || !Number.isFinite(line.ingredientsCentsToday) || line.ingredientsCentsToday < 0) {
      missingProductCosts = true;
      continue;
    }
    rawCostCents += line.ingredientsCentsToday * quantity;
    if (line.costQuality === "estimated") usesEstimatedProductCosts = true;
  }

  return {
    totalCostCents: Math.round(rawCostCents),
    missingProductCosts,
    usesEstimatedProductCosts,
  };
}
