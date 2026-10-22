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
