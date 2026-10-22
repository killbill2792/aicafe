/** Pure, deterministic as-of price selection shared by P1 atomic projections and
 * Alex pricing. A corrected same-day pack price is not an ambiguous ingredient. */
export type EffectiveIngredientPrice = {
  id: string;
  ingredient_id: string;
  effective_from: string;
  recorded_at?: string;
  cost_per_base_unit_micros: number;
};
export type EffectivePriceChoice<T> =
  | { status: "ready"; price: T }
  | { status: "missing" | "ambiguous" | "invalid" };

export function latestEffectiveIngredientPrice<T extends EffectiveIngredientPrice>(
  prices: readonly T[], ingredientId: string, day: string,
): EffectivePriceChoice<T> {
  const eligible = prices.filter(p => p.ingredient_id === ingredientId && p.effective_from <= day);
  if (!eligible.length) return { status: "missing" };
  const latestDate = eligible.reduce((d, p) => p.effective_from > d ? p.effective_from : d, "");
  const latest = eligible.filter(p => p.effective_from === latestDate);
  // The old atomic snapshot contract lacked recorded_at. Never invent a
  // same-day order for historical/fixture payloads where it is absent.
  if (latest.length > 1 && latest.some(p => !p.recorded_at))
    return { status: "ambiguous" };
  const dates = latest.map(p => p.recorded_at ? Date.parse(p.recorded_at) : 0);
  if (dates.some(n => !Number.isFinite(n))) return { status: "invalid" };
  const ordered = latest.map((price, index) => ({ price, timestamp: dates[index] }))
    .sort((a,b) => b.timestamp-a.timestamp || b.price.id.localeCompare(a.price.id,"en"));
  const selected = ordered[0]?.price;
  if (!selected || !Number.isSafeInteger(selected.cost_per_base_unit_micros) ||
      selected.cost_per_base_unit_micros < 0) return { status: "invalid" };
  return { status: "ready", price: selected };
}
