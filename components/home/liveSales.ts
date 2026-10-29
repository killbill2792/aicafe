/** How Home shows the saved live Toast reading for Today. Fresh means the
 * 15-minute job or the chat read Toast in the last 30 minutes. A reading for
 * another business day (for example saved before closeout) is never shown as
 * today. Orders Toast sent that could not be read are named, never hidden. */
export const LIVE_FRESH_MS=30*60_000;
export type LiveSalesView={netSalesCents:number|null;time:string;fresh:boolean;unreadOrders:number};
export function liveSalesView(live:{value:{netSalesCents:number;readAt:string;businessDate:string;orders:number;unparsedOrders:number};ageMs:number}|null,
 timezone:string|null,locale:string,businessDay:string|null):LiveSalesView|null{
 if(!live||!businessDay||live.value.businessDate!==businessDay)return null;
 const time=new Intl.DateTimeFormat(locale,{hour:"numeric",minute:"2-digit",
  ...(timezone?{timeZone:timezone}:{})}).format(new Date(live.value.readAt));
 const unread=live.value.unparsedOrders;
 // Nothing readable at all: the total is unknown, not zero.
 return {netSalesCents:unread>0&&live.value.orders===0?null:live.value.netSalesCents,time,
  fresh:live.ageMs<LIVE_FRESH_MS,unreadOrders:unread};
}
