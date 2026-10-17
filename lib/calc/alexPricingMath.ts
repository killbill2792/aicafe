import { baselinePriceCents } from "./pricingBaseline";
import { roundHalfUpToCent } from "./money";

/** Integer microcents per canonical base unit. A US gallon is exactly
 * 3785.411784 ml; `fl_oz` follows the existing recipe UI's 29.5735 ml.
 * Package quantity is an integer, never a floating point purchase count.
 */
export function supplierPackageMicrocents(
  costCents: number, packageCount: number,
  packageUnit: "gal" | "fl_oz" | "ml" | "g" | "each",
  baseUnit: "ml" | "g" | "each",
): number | null {
  if (!Number.isSafeInteger(costCents) || costCents < 0 ||
      !Number.isSafeInteger(packageCount) || packageCount <= 0) return null;
  if ((baseUnit === "ml" && !["gal", "fl_oz", "ml"].includes(packageUnit)) ||
      (baseUnit === "g" && packageUnit !== "g") ||
      (baseUnit === "each" && packageUnit !== "each")) return null;
  const quantityMicroUnits = packageUnit === "gal" ? BigInt("3785411784") :
    packageUnit === "fl_oz" ? BigInt("29573500") : BigInt("1000000");
  const denominator = BigInt(packageCount) * quantityMicroUnits;
  const numerator = BigInt(costCents) * BigInt("1000000000000");
  const rounded = (numerator + denominator / BigInt("2")) / denominator;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

export function scaleMicrocents(micros: number, multiplierBasisPoints: number): number | null {
  if (!Number.isSafeInteger(micros) || micros < 0 ||
      !Number.isSafeInteger(multiplierBasisPoints) || multiplierBasisPoints < 0) return null;
  const result = (BigInt(micros) * BigInt(multiplierBasisPoints) + BigInt("5000")) / BigInt("10000");
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

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

/** Explicit owner-selected ingredient-cost target; no default 'industry target'. */
export function conditionalTargetPrice(rawCostCents:number,targetCostRatioBps:number):number|null {
  if (!(rawCostCents > 0) || !Number.isFinite(rawCostCents) ||
      !Number.isSafeInteger(targetCostRatioBps) ||
      targetCostRatioBps <= 0 || targetCostRatioBps > 10000) return null;
  const suggested = Math.ceil(baselinePriceCents(rawCostCents,targetCostRatioBps/10000));
  return Number.isSafeInteger(suggested) ? suggested : null;
}
