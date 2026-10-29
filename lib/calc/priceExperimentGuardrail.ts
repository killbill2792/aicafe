import {z} from "zod";

/** A price test should not cost the café customers: total orders are watched
 * next to the item's sales. Each test day is compared with the same weekday
 * one and two weeks earlier (both before the test, which runs 7 days). */
export const ORDERS_GUARDRAIL_DROP_PCT=10;
export const cafeOrdersSchema=z.object({
  value:z.number().nonnegative().nullable(),
  baseline:z.array(z.object({date:z.iso.date(),value:z.number().nonnegative().nullable()})),
});
export type CafeOrdersReading=z.infer<typeof cafeOrdersSchema>;
export type OrdersGuardrail=
  |{status:"unknown";countedDays:number}
  |{status:"ok"|"broken";countedDays:number;changePct:number;ordersNow:number;ordersBefore:number};

export function ordersGuardrail(days:ReadonlyArray<CafeOrdersReading|null>):OrdersGuardrail{
  let now=0,before=0,counted=0;
  for(const d of days){
    if(!d||d.value===null)continue;
    const base=d.baseline.flatMap(b=>b.value===null?[]:[b.value]);
    if(base.length===0)continue;
    now+=d.value;before+=base.reduce((a,c)=>a+c,0)/base.length;counted++;
  }
  if(counted===0||before<=0)return {status:"unknown",countedDays:counted};
  const changePct=Math.round((now-before)/before*1000)/10;
  return {status:changePct<=-ORDERS_GUARDRAIL_DROP_PCT?"broken":"ok",countedDays:counted,changePct,
    ordersNow:now,ordersBefore:Math.round(before)};
}
