import type { ModifierDelta, RecipeLine } from "./types";

/**
 * Theoretical cost of one item = Σ recipe lines (quantity × recipe cost) + modifier deltas.
 * `priceMicrosByIngredient` is cost_per_base_unit_micros (micro-cents per base unit) keyed by
 * ingredient id, at the price in effect on the day being costed.
 */
export function itemIngredientCostCents(
  recipeLines: RecipeLine[],
  priceMicrosByIngredient: Record<string, number>,
  modifiers: ModifierDelta[] = [],
): number {
  const baseMicros = recipeLines.reduce(
    (sum, line) => sum + line.quantity * (priceMicrosByIngredient[line.ingredientId] ?? 0),
    0,
  );
  const modifierMicros = modifiers.reduce(
    (sum, m) => sum + m.quantityDelta * (priceMicrosByIngredient[m.ingredientId] ?? 0),
    0,
  );
  return (baseMicros + modifierMicros) / 1_000_000;
}

/** Sum of theoretical ingredient cost across many sold lines (a day, a period, ...). */
export function sumTheoreticalIngredientsCents<T>(
  lines: T[],
  costForLine: (line: T) => number,
): number {
  return lines.reduce((sum, line) => sum + costForLine(line), 0);
}

/**
 * A suggested menu price, grounded purely in ingredient cost — for an item with no sales history
 * yet (a brand-new menu item), staff-time-per-drink and rent-share-per-drink can't be computed
 * (both derive from quantity sold), so this deliberately only targets ingredient cost as a share
 * of price. Defaults to 30%, the midpoint of docs/05-calculations.md's documented "healthy"
 * ingredients band (25-35% of net sales). Rounds UP to the next 25¢ (matching the app's existing
 * 25¢ price-increment convention, e.g. Break-even's "raise all prices 25¢" what-if) so the
 * suggestion never quietly lands under the target margin.
 */
export function recommendedPriceCents(ingredientsCostCents: number, targetIngredientRatio = 0.3): number {
  if (ingredientsCostCents <= 0 || targetIngredientRatio <= 0) return 0;
  const rawCents = ingredientsCostCents / targetIngredientRatio;
  return Math.ceil(rawCents / 25) * 25;
}
