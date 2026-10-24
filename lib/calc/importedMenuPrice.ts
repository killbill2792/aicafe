/** CSV grouped sales represent realized unit averages, never verified list prices.
 * Use the median across groups to avoid anchoring on an arbitrary import day. */
export function medianObservedUnitPriceCents(
 groups:ReadonlyArray<{netSalesCents:number;quantity:number}>,
):number|null{
 const prices=groups.filter(g=>Number.isFinite(g.netSalesCents)&&Number.isFinite(g.quantity)&&g.quantity>0)
   .map(g=>Math.round(g.netSalesCents/g.quantity))
   .filter(cents=>Number.isSafeInteger(cents)&&cents>0).sort((a,b)=>a-b);
 if(!prices.length)return null;
 const i=Math.floor(prices.length/2);
 return prices.length%2?prices[i]:Math.round((prices[i-1]+prices[i])/2);
}
