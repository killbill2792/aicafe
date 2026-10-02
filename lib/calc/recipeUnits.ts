export type BaseUnit = "g" | "ml" | "each";
export type OperationalUnit = "shot" | "pump";
export type RecipeDisplayUnit = "g" | "ml" | "fl_oz" | "each" | OperationalUnit;

/** True physical units convert with a single fixed, global constant — unlike shots/pumps, which
 * are ingredient-specific (see toBaseUnitQuantity) and must never be hardcoded here: a double-shot
 * espresso dose in grams and a vanilla-syrup pump in ml are unrelated numbers that vary per
 * ingredient (and even per bottle), not universal units of measure. */
const ML_PER_FL_OZ = 29.5735;

export type IngredientUnitConversion = { unit: OperationalUnit; baseUnitsPerUnit: number };

/** Units safe to offer for this exact ingredient. Operational units appear only when that
 * ingredient already has the corresponding stored conversion; a recipe editor never invents one. */
export function recipeDisplayUnitsFor(baseUnit: BaseUnit, conversions: readonly IngredientUnitConversion[] = []): RecipeDisplayUnit[] {
  if (baseUnit === "each") return ["each"];
  const physical: RecipeDisplayUnit[] = baseUnit === "ml" ? ["ml", "fl_oz"] : ["g"];
  return [...physical, ...conversions.map((conversion) => conversion.unit)];
}

export function needsIngredientConversion(unit: RecipeDisplayUnit): unit is OperationalUnit {
  return unit === "shot" || unit === "pump";
}

/** Converts a café-friendly display quantity into the ingredient's canonical base-unit quantity.
 * Returns null when the quantity isn't a positive number, when a physical unit (g/ml/fl_oz/each)
 * doesn't match the ingredient's actual base unit (e.g. "fl oz" on a gram-based ingredient), or
 * when the unit is an ingredient-specific operational unit (shot/pump) with no stored conversion
 * yet — callers must prompt the owner to define one before the line can be saved; never guess a
 * default, since a shot/pump dose genuinely varies per ingredient. This is the server-side source
 * of truth for unit compatibility — it must never trust a client to have only offered valid
 * combinations (see recipeDisplayUnitsFor, which is a UI convenience, not a guarantee). */
export function toBaseUnitQuantity(
  unit: RecipeDisplayUnit,
  quantity: number,
  baseUnit: BaseUnit,
  conversions: IngredientUnitConversion[] = [],
): number | null {
  if (!(quantity > 0)) return null;
  if (needsIngredientConversion(unit)) {
    const conversion = conversions.find((c) => c.unit === unit);
    return conversion ? quantity * conversion.baseUnitsPerUnit : null;
  }
  if (unit === "g") return baseUnit === "g" ? quantity : null;
  if (unit === "ml") return baseUnit === "ml" ? quantity : null;
  if (unit === "fl_oz") return baseUnit === "ml" ? quantity * ML_PER_FL_OZ : null;
  if (unit === "each") return baseUnit === "each" ? quantity : null;
  return null;
}
