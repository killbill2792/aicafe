import {addCalendarDays,localClock} from "./scheduleDates";
import type {ToastDayPage,ToastParsedOrder} from "./dayParser";

export type LiveHourlySale={hourLocal:number;netSalesCents:number;ordersCount:number};

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
  /** Same Toast net cents as the day total, grouped by café-local hour. */
  hourlySales?:LiveHourlySale[];
  /** Never assign the parser's noon placeholder to an hourly bucket. */
  hourlyUnassignedOrders?:number;
  /** Locations read and failed; a failed location's sales are not in the totals. */
  locationsRead:number;locationsFailed:number;
  /** True when the page limit stopped the read, so totals may be low. */
  truncated:boolean;
};

/** Sums one business day's parsed Toast pages from every location. The latest
 * revision of an order wins, as in the closeout import. */
export function summarizeToastToday(input:{businessDate:string;readAt:string;timezone:string;
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
  const byHour=new Map<number,{netSalesCents:number;ordersCount:number}>();
  let hourlyUnassignedOrders=0;
  for(const o of orders){
    if(!o.normalized)continue;
    const stamp=o.hourObservedAt?Date.parse(o.hourObservedAt):NaN;
    if(!Number.isFinite(stamp)){hourlyUnassignedOrders++;continue;}
    let hour:number;
    try{
      hour=Number(new Intl.DateTimeFormat("en-GB",{
        timeZone:input.timezone,hour:"2-digit",hourCycle:"h23",
      }).format(new Date(stamp)));
    }catch{hourlyUnassignedOrders++;continue;}
    if(!Number.isInteger(hour)||hour<0||hour>23){hourlyUnassignedOrders++;continue;}
    const existing=byHour.get(hour)??{netSalesCents:0,ordersCount:0};
    existing.netSalesCents+=o.normalized.netSalesCents;
    existing.ordersCount++;
    byHour.set(hour,existing);
  }
  const hourlySales=[...byHour.entries()].sort(([a],[b])=>a-b)
    .map(([hourLocal,row])=>({hourLocal,...row}));
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
    hourlySales,hourlyUnassignedOrders,
    locationsRead:input.locationsRead,locationsFailed:input.locationsFailed,truncated:input.truncated};
}
