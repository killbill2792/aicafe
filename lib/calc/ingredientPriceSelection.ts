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

/** UTC microsecond ordering. Date.parse drops digits after milliseconds; that would
 * make distinct PostgreSQL recorded_at values look tied and select the wrong row. */
function microsecondEpoch(iso: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!match) return null;
  const seconds = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(seconds)) return null;
  return BigInt(seconds) * BigInt(1000) + BigInt((match[2] ?? "").padEnd(6,"0") || "0");
}

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
  const dates = latest.map(p => p.recorded_at ? microsecondEpoch(p.recorded_at) : BigInt(0));
  if (dates.some(n => n === null)) return { status: "invalid" };
  const ordered = latest.map((price, index) => ({ price, timestamp: dates[index]! }))
    .sort((a,b) => a.timestamp === b.timestamp
      ? (a.price.id === b.price.id ? 0 : a.price.id < b.price.id ? 1 : -1)
      : a.timestamp < b.timestamp ? 1 : -1);
  const selected = ordered[0]?.price;
  if (!selected || !Number.isSafeInteger(selected.cost_per_base_unit_micros) ||
      selected.cost_per_base_unit_micros < 0) return { status: "invalid" };
  return { status: "ready", price: selected };
}
