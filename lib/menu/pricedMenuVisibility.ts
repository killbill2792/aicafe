/** Existing menu screens assume every size has a selling price and compute margin
 * with it. Until a separate UI PR supports "Price not set", never feed those
 * screens a null-priced item as if its price were zero. The rows remain stored
 * and accessible to the backend all-sizes recipe actions by ID. */
export function visiblePricedMenuItems<T extends { price_cents: number | null }>(
  items: readonly T[],
): Array<T & {price_cents: number}> {
  return items.filter((item): item is T & {price_cents: number} => item.price_cents !== null);
}
