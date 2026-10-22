/** Complete order-level reconciliation is required before item NET revenue can
 * be treated as attributed. Provider-level discounts/refunds often live on the
 * order/check rather than the item. No proportional allocation is invented. */
export type ItemRevenueOrder={id:string;netSalesCents:number};
export type ItemRevenueLine={
  orderId:string;itemId:string;quantity:number;revenueCents:number;
};
export function reconcileAttributedItemRevenue(
  orders:readonly ItemRevenueOrder[],lines:readonly ItemRevenueLine[],
):{verified:boolean;items:Array<{itemId:string;units:number;revenueCents:number}>} {
  const byOrder=new Map<string,number>(),byItem=new Map<string,{units:number;revenueCents:number}>();
  let valid=true;
  for(const line of lines){
    if(!line.orderId||!line.itemId||!Number.isFinite(line.quantity)||
      !Number.isSafeInteger(line.revenueCents))valid=false;
    byOrder.set(line.orderId,(byOrder.get(line.orderId)??0)+line.revenueCents);
    const prior=byItem.get(line.itemId)??{units:0,revenueCents:0};
    prior.units+=line.quantity;prior.revenueCents+=line.revenueCents;
    byItem.set(line.itemId,prior);
  }
  const verified=valid&&orders.length===byOrder.size&&
    orders.every(order=>Number.isSafeInteger(order.netSalesCents)&&
      byOrder.get(order.id)===order.netSalesCents);
  return {verified,items:[...byItem].map(([itemId,totals])=>({itemId,...totals}))};
}


/** Canonical SQL quantities are an independent completeness witness.
 * Missing/truncated detailed rows must never be reinterpreted as verified zero.
 */
export function reconcileItemUnitsToCanonical(
  items:readonly {itemId:string;units:number}[],
  canonical:readonly {id:string;units:number}[],
):boolean {
  if(items.length!==canonical.length)return false;
  const totals=new Map<string,number>();
  for(const row of items){
    if(!row.itemId||!Number.isFinite(row.units)||row.units<0||
      totals.has(row.itemId))return false;
    totals.set(row.itemId,row.units);
  }
  for(const row of canonical){
    if(!Number.isFinite(row.units)||row.units<0||
      !totals.has(row.id)||totals.get(row.id)!==row.units)return false;
  }
  return true;
}
