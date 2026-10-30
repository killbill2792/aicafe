import {normalizeOpenHours,OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";

/** A café with no configured hours cannot be claimed open by the scheduler.
 * Overnight intervals from the previous weekday are respected. */
export function withinCafeOpenHours(values:readonly unknown[],day:string,time:string):boolean{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
   return false;
 const weekday=new Date(day+"T00:00:00Z").getUTCDay();
 if(Number.isNaN(weekday))return false;
 const key=OPEN_HOURS_DAY_KEYS[weekday],previous=OPEN_HOURS_DAY_KEYS[(weekday+6)%7];
 return values.some(value=>{
   const hours=normalizeOpenHours(value);
   if(!hours)return false;
   return (hours[key]??[]).some(([start,end])=>
      start<=end?time>=start&&time<end:time>=start)||
     (hours[previous]??[]).some(([start,end])=>start>end&&time<end);
 });
}
