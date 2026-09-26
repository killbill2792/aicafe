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
