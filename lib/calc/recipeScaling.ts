import type { RecipeDisplayUnit } from "./recipeUnits";
export type ScalingLine = { starterKey: string; displayUnit: RecipeDisplayUnit; displayQuantity: number };

export function shotsForSize(size: number): number {
  if (size <= 8) return 1;
  if (size <= 16) return 2;
  return 3;
}
export function halfOunce(value: number): number {
  return Math.max(0.5, Math.round(value * 2) / 2);
}
const line = (starterKey: string, displayQuantity: number, displayUnit: RecipeDisplayUnit): ScalingLine =>
  ({ starterKey, displayQuantity, displayUnit });

/** Editable suggestions only. Ratios aren't supplier specs; a café can override them.
 * The matching cup and packaging are included in the costed recipe, not assumed free. */
export function buildTemplateRecipe(key: string, sizeOz: number, iced: boolean, defaultMilkKey: string | null): ScalingLine[] {
  const ratio = sizeOz / (iced ? 16 : 12);
  const oz = (base: number) => halfOunce(base * ratio);
  const shot = () => line("espresso-beans", shotsForSize(sizeOz), "shot");
  const milk = (base: number) => line(defaultMilkKey!, oz(base), "fl_oz");
  let ingredients: ScalingLine[] = [];
  switch (key) {
    case "latte": ingredients = [shot(), milk(10)]; break;
    case "cappuccino": ingredients = [shot(), milk(7)]; break;
    case "flat-white": ingredients = [shot(), milk(8)]; break;
    case "cortado": ingredients = [shot(), milk(4)]; break;
    case "americano": ingredients = [shot(), line("filtered-water", oz(10), "fl_oz")]; break;
    case "mocha": ingredients = [shot(), milk(9), line("sauce-mocha", 2, "pump")]; break;
    case "macchiato": ingredients = [shot(), milk(9), line("syrup-vanilla", 2, "pump"), line("sauce-caramel", 1, "pump")]; break;
    case "iced-latte": ingredients = [shot(), milk(12)]; break;
    case "cold-brew": ingredients = [line("cold-brew-concentrate", oz(8), "fl_oz"), line("filtered-water", oz(4), "fl_oz")]; break;
    case "drip": ingredients = [line("drip-coffee", Math.max(1, Math.round(24 * ratio)), "g"), line("filtered-water", oz(12), "fl_oz")]; break;
    case "chai-latte": ingredients = [line("chai-concentrate", oz(5), "fl_oz"), milk(7)]; break;
    case "matcha-latte": ingredients = [line("matcha", Math.max(1, Math.round(3 * ratio)), "g"), milk(10)]; break;
    case "hot-tea": ingredients = [line("tea-bag", sizeOz < 16 ? 1 : 2, "each"), line("filtered-water", oz(12), "fl_oz")]; break;
  }
  const container = line(`cup-${iced ? "cold" : "hot"}-${sizeOz}`, 1, "each");
  return [...ingredients, container, line(iced ? "lid-cold" : "lid-hot", 1, "each"),
    line(iced ? "straw" : "sleeve", 1, "each")];
}

/** Generic manual recipe cloning: keep countable packaging at one, scale liquid to ½ oz,
 * shots by size-specific dose rules, and other ingredient amounts by source/target ratio. */
export function scaledScalingLines(
  lines: readonly ScalingLine[], fromOz: number, toOz: number, iced: boolean,
): ScalingLine[] {
  if (!(fromOz > 0) || !(toOz > 0)) throw new RangeError("Invalid size");
  return lines.map((item) => {
    if (item.starterKey.startsWith("cup-")) return { ...item, starterKey: `cup-${iced ? "cold" : "hot"}-${toOz}`, displayQuantity: 1 };
    if (item.starterKey.startsWith("lid-") || item.starterKey === "sleeve" || item.starterKey === "straw")
      return { ...item, displayQuantity: 1 };
    const ratio = toOz / fromOz;
    if (item.displayUnit === "shot") return { ...item, displayQuantity: Math.max(1, Math.round(item.displayQuantity * shotsForSize(toOz) / shotsForSize(fromOz))) };
    if (item.displayUnit === "fl_oz") return { ...item, displayQuantity: halfOunce(item.displayQuantity * ratio) };
    const step = item.displayUnit === "pump" || item.displayUnit === "each" || item.displayUnit === "g" ? 1 : 0.5;
    return { ...item, displayQuantity: Math.max(step, Math.round(item.displayQuantity * ratio / step) * step) };
  });
}
