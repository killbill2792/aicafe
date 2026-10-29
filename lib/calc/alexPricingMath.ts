import { roundHalfUpToCent } from "./money";

/** Uses canonical recipe cost (fractional cents internally); rounds once when
 * presenting money. These are ingredient-only contributions, NOT true profit. */
export function ingredientOnlyEconomics(rawCostCents: number, priceCents: number | null) {
  if (!Number.isFinite(rawCostCents) || rawCostCents < 0 ||
      rawCostCents > Number.MAX_SAFE_INTEGER) return null;
  const ingredientCostCents = roundHalfUpToCent(rawCostCents);
  if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents < 0)
    return {ingredientCostCents, costRatioBasisPoints:null,
      ingredientContributionCents:null, ingredientContributionBasisPoints:null};
  if (priceCents === 0)
    return {ingredientCostCents, costRatioBasisPoints:null,
      ingredientContributionCents:-ingredientCostCents, ingredientContributionBasisPoints:null};
  const ratio = roundHalfUpToCent(rawCostCents / priceCents * 10000);
  return {ingredientCostCents, costRatioBasisPoints:ratio,
    ingredientContributionCents:priceCents - ingredientCostCents,
    ingredientContributionBasisPoints:10000-ratio};
}
