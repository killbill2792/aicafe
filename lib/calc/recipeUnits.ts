export type BaseUnit = "g" | "ml" | "each";
export type OperationalUnit = "shot" | "pump";
export type RecipeDisplayUnit = "g" | "ml" | "fl_oz" | "each" | OperationalUnit;

/** True physical units convert with a single fixed, global constant — unlike shots/pumps, which
 * are ingredient-specific (see toBaseUnitQuantity) and must never be hardcoded here: a double-shot
 * espresso dose in grams and a vanilla-syrup pump in ml are unrelated numbers that vary per
 * ingredient (and even per bottle), not universal units of measure. */
const ML_PER_FL_OZ = 29.5735;

export type IngredientUnitConversion = { unit: OperationalUnit; baseUnitsPerUnit: number };

/** Units an owner may choose for this ingredient type. Pump is a useful volume measure and Shot
 * is a useful weight measure, but selecting either still requires an ingredient-specific stored
 * conversion before save (enforced by toBaseUnitQuantity and the recipe UI). Existing conversions
 * remain available even for less common canonical types so previously-entered data is editable. */
export function recipeDisplayUnitsFor(baseUnit: BaseUnit, conversions: readonly IngredientUnitConversion[] = []): RecipeDisplayUnit[] {
  if (baseUnit === "each") return ["each"];
  const physical: RecipeDisplayUnit[] = baseUnit === "ml" ? ["ml", "fl_oz"] : ["g"];
  const useful: OperationalUnit[] = baseUnit === "ml" ? ["pump"] : ["shot"];
  return [...physical, ...new Set([...useful, ...conversions.map((conversion) => conversion.unit)])];
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


/** Purchase packs are defined against an ingredient's canonical g/ml/each unit. The same
 * bottle label "oz" means *fluid* ounces only for liquids and *weight* ounces for solids. */
export type PackUnit = "gal" | "qt" | "l" | "ml" | "fl_oz" | "lb" | "kg" | "oz_wt" | "g" | "each" | "dozen" | `case(${number})` | "oz";
const PACK_TO_BASE: Record<Exclude<PackUnit, `case(${number})` | "oz">, readonly [BaseUnit, number]> = {
  gal: ["ml", 3785.411784], qt: ["ml", 946.352946], l: ["ml", 1000],
  ml: ["ml", 1], fl_oz: ["ml", 29.5735295625],
  lb: ["g", 453.59237], kg: ["g", 1000], oz_wt: ["g", 28.349523125],
  g: ["g", 1], each: ["each", 1], dozen: ["each", 12],
};

/** Returns null rather than silently treating a weight pack as a liquid pack, or vice versa. */
export function packBaseQuantity(packQuantity: number, packUnit: string, baseUnit: BaseUnit): number | null {
  if (!Number.isFinite(packQuantity) || packQuantity <= 0) return null;
  const unit = packUnit === "oz" ? (baseUnit === "ml" ? "fl_oz" : "oz_wt") : packUnit;
  const matchedCase = /^case\(([1-9]\d*)\)$/.exec(unit);
  const definition: readonly [BaseUnit, number] | undefined = matchedCase
    ? ["each", Number(matchedCase[1])]
    : Object.hasOwn(PACK_TO_BASE, unit)
      ? PACK_TO_BASE[unit as keyof typeof PACK_TO_BASE]
      : undefined;
  if (!definition || definition[0] !== baseUnit || !Number.isSafeInteger(definition[1]) && matchedCase) return null;
  const baseQuantity = packQuantity * definition[1];
  return Number.isFinite(baseQuantity) && baseQuantity > 0 ? baseQuantity : null;
}

/** Price is integer cents; stored price is integer MICRO-CENTS per canonical unit.
 * Round once at the final step, consistent with existing ingredient_prices rows. */
export function packToCostPerBaseMicros(
  packQuantity: number, packUnit: string, packCostCents: number, baseUnit: BaseUnit,
): number | null {
  if (!Number.isSafeInteger(packCostCents) || packCostCents <= 0) return null;
  const baseQuantity = packBaseQuantity(packQuantity, packUnit, baseUnit);
  if (baseQuantity === null) return null;
  const result = Math.round(packCostCents * 1_000_000 / baseQuantity);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export type PlainUnit = RecipeDisplayUnit | "oz_wt" | "cup";
export function stepFor(unit: PlainUnit): number {
  return unit === "fl_oz" || unit === "oz_wt" ? 0.5 : 1;
}

/** No fractional decimals in the everyday recipe summary. Quarter fractions are intentional,
 * and plural categories use Intl.PluralRules (ICU), rather than a hardcoded English n!==1. */
export function plainQuantity(
  quantity: number, unit: PlainUnit, locale = "en", cupSizeOz?: number,
): string {
  if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError("Invalid quantity");
  const roundedQuarters = Math.round(quantity * 4);
  const whole = Math.floor(roundedQuarters / 4);
  const remainder = roundedQuarters % 4;
  const fraction = ["", "¼", "½", "¾"][remainder];
  const numeric = (whole ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole) : "") + fraction || "0";
  const plural = new Intl.PluralRules(locale).select(roundedQuarters / 4);
  const one = plural === "one";
  const labels: Record<string, Record<PlainUnit, readonly [string, string]>> = {
    en: { shot: ["shot", "shots"], pump: ["pump", "pumps"], fl_oz: ["oz", "oz"], oz_wt: ["oz", "oz"], g: ["g", "g"], ml: ["ml", "ml"], each: ["item", "items"], cup: ["cup", "cups"] },
    es: { shot: ["shot", "shots"], pump: ["pulsación", "pulsaciones"], fl_oz: ["oz", "oz"], oz_wt: ["oz", "oz"], g: ["g", "g"], ml: ["ml", "ml"], each: ["unidad", "unidades"], cup: ["taza", "tazas"] },
    ar: { shot: ["جرعة", "جرعات"], pump: ["ضغطة", "ضغطات"], fl_oz: ["أونصة", "أونصات"], oz_wt: ["أونصة", "أونصات"], g: ["غ", "غ"], ml: ["مل", "مل"], each: ["قطعة", "قطع"], cup: ["كوب", "أكواب"] },
  };
  const key = locale.split("-")[0];
  const terms = labels[key] ?? labels.en;
  const label = terms[unit][one ? 0 : 1];
  const cup = unit === "cup" && cupSizeOz !== undefined
    ? ` (${plainQuantity(cupSizeOz, "fl_oz", locale)})`
    : "";
  return `${numeric} ${label}${cup}`;
}
