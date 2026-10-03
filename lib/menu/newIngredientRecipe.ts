import { needsIngredientConversion, type RecipeDisplayUnit } from "@/lib/calc/recipeUnits";

/** Puts the first operational-unit size first so addRecipeLine can create a brand-new ingredient
 * and its exact pump/shot conversion together. Remaining sizes then reuse that ingredient by name. */
export function prepareNewIngredientAdditions<T extends { amount: { unit: RecipeDisplayUnit } }>(additions: T[]): {
  operationalUnit: "pump" | "shot" | null;
  ordered: T[];
} {
  const operationalUnit = additions.map(({ amount }) => amount.unit).find(needsIngredientConversion) ?? null;
  if (!operationalUnit) return { operationalUnit: null, ordered: additions };
  return {
    operationalUnit,
    ordered: [...additions].sort((a, b) => Number(b.amount.unit === operationalUnit) - Number(a.amount.unit === operationalUnit)),
  };
}
