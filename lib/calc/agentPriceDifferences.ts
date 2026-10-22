/** Pure integer-cents math for an explicitly phrased menu-price difference.
 * These values never authorize profits, generic counts or percentage claims. */
export function menuPriceDifferencesCents(prices: readonly number[]): ReadonlySet<number> {
  const amounts=[...new Set(prices.filter(n=>Number.isSafeInteger(n)))].slice(0,25);
  const differences=new Set<number>();
  for(let i=0;i<amounts.length;i++)
    for(let j=i+1;j<amounts.length;j++)
      differences.add(Math.abs(amounts[i]-amounts[j]));
  return differences;
}
