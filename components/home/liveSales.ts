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

/** A rollup row alone does not prove today's sales were closed out. A zero
 * amount or a missing/not-final sales status still needs the live reading. */
export function needsHomeLiveReading(businessDay:string|null,
 recordedDays:ReadonlyArray<{date:string;netSalesCents:number;salesDataStatus?:string}>):boolean{
 if(!businessDay)return false;
 const day=recordedDays.find(row=>row.date===businessDay);
 return !day||day.salesDataStatus!=="actual"||day.netSalesCents===0;
}

/** A saved reading from a previous business day must trigger a new read. */
export function needsHomeLiveFallback(live:{value:{businessDate:string}}|null,businessDay:string|null):boolean{
 return Boolean(businessDay)&&(!live||live.value.businessDate!==businessDay);
}
