import {addCalendarDays,localClock} from "./scheduleDates";
import type {ToastDayPage,ToastParsedOrder} from "./dayParser";

/** Toast's current business day: before the closeout hour, the previous
 * calendar day is still open. */
export function currentToastBusinessDay(now:Date,timezone:string,closeoutHour:number):string{
  const clock=localClock(now,timezone);
  return clock.minutes<closeoutHour*60?addCalendarDays(clock.today,-1):clock.today;
}

export type TodaySoFar={
  /** Always provisional: replaced by the final import after closeout. */
  provisional:true;
  businessDate:string;readAt:string;
  netSalesCents:number;grossSalesCents:number;discountsCents:number;refundsCents:number;tipCents:number;
  orders:number;openChecks:number;unparsedOrders:number;
  topItems:Array<{name:string;quantity:number;netSalesCents:number}>;
  /** Locations read and failed; a failed location's sales are not in the totals. */
  locationsRead:number;locationsFailed:number;
  /** True when the page limit stopped the read, so totals may be low. */
  truncated:boolean;
};

/** Sums one business day's parsed Toast pages from every location. The latest
 * revision of an order wins, as in the closeout import. */
export function summarizeToastToday(input:{businessDate:string;readAt:string;
  pages:readonly ToastDayPage[];locationsRead:number;locationsFailed:number;truncated:boolean}):TodaySoFar{
  const byGuid=new Map<string,ToastParsedOrder>();
  let unparsed=0;
  for(const page of input.pages){
    unparsed+=page.unparsed.length;
    for(const order of page.orders){
      const prev=byGuid.get(order.guid);
      if(!prev||prev.modifiedDate<=order.modifiedDate)byGuid.set(order.guid,order);
    }
  }
  const orders=[...byGuid.values()];
  const counted=orders.flatMap(o=>o.normalized?[o.normalized]:[]);
  const sum=(f:(o:typeof counted[number])=>number)=>counted.reduce((s,o)=>s+f(o),0);
  const items=new Map<string,{name:string;quantity:number;netSalesCents:number}>();
  for(const line of counted.flatMap(o=>o.lines)){
    if(line.voided)continue;
    const key=line.posItemId??"name:"+line.name;
    const row=items.get(key)??{name:line.name,quantity:0,netSalesCents:0};
    row.quantity+=line.quantity;row.netSalesCents+=line.netSalesCents;
    items.set(key,row);
  }
  return {provisional:true,businessDate:input.businessDate,readAt:input.readAt,
    netSalesCents:sum(o=>o.netSalesCents),grossSalesCents:sum(o=>o.grossSalesCents),
    discountsCents:sum(o=>o.discountsCents),refundsCents:sum(o=>o.refundsCents),
    tipCents:sum(o=>o.tipCents),orders:counted.length,
    openChecks:orders.reduce((s,o)=>s+o.openChecks,0),unparsedOrders:unparsed,
    topItems:[...items.values()].sort((a,b)=>b.quantity-a.quantity||b.netSalesCents-a.netSalesCents).slice(0,5),
    locationsRead:input.locationsRead,locationsFailed:input.locationsFailed,truncated:input.truncated};
}
