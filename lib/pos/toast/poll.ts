import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {normalizeOpenHours,OPEN_HOURS_DAY_KEYS,type OpenHours} from "@/lib/business/openHours";
import {createToastAdapter} from "./adapter";
import {syncToastLaborReadOnly} from "./laborSync";
import {GUID,ToastApiError} from "./client";
import {orderEventRetryAt} from "./orderQueue";
import {formatInTimeZone,fromZonedTime} from "date-fns-tz";
import {addDays,parseISO} from "date-fns";
export type ToastPollKind="orders"|"attendance"|"schedules";
export type ToastPollParams={businessId:string;locationId:string;restaurantGuid:string;kind:ToastPollKind};
const weekdays=["sun","mon","tue","wed","thu","fri","sat"] as const;
const hhmm=(v:string)=>Number(v.slice(0,2))*60+Number(v.slice(3,5));
/** Unknown hours are not permission to continuously poll a closed café.
 * Account for intervals that cross local midnight and a preceding day's schedule. */
export function isCafeCurrentlyOpen(openHours:OpenHours|null,timezone:string,at:Date):boolean {
 const hours=normalizeOpenHours(openHours);
 if(!hours)return false;
 let day=0,minutes=0;
 try {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,weekday:"short",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(at);
  const pick=(part:string)=>parts.find(p=>p.type===part)?.value??"";
  const weekday=pick("weekday").toLowerCase().slice(0,3);
  day=weekdays.indexOf(weekday as typeof weekdays[number]);
  minutes=Number(pick("hour"))*60+Number(pick("minute"));
  if(day<0||!Number.isFinite(minutes))return false;
 }catch{return false;}
 const current=OPEN_HOURS_DAY_KEYS[day];
 const previous=OPEN_HOURS_DAY_KEYS[(day+6)%7];
 for(const [a,b] of hours[current]??[]) {
  const start=hhmm(a),end=hhmm(b);
  if(start<end&&minutes>=start&&minutes<end)return true;
  if(start>=end&&minutes>=start)return true;
 }
 for(const [a,b] of hours[previous]??[]) {
  const start=hhmm(a),end=hhmm(b);
  if(start>=end&&minutes<end)return true;
 }
 return false;
}
export type PollFreshness="current"|"behind"|"recoverable_backlog"|"requires_historical_backfill";
export function planModifiedWindow(cursor:string|null,now:Date):{
 status:PollFreshness;range:{since:Date;until:Date}|null
} {
 const upper=now.getTime()-120000;
 if(!Number.isFinite(upper))throw new ToastApiError("invalid_response");
 if(cursor&&(!Number.isFinite(Date.parse(cursor))))throw new ToastApiError("invalid_response");
 const last=cursor?Date.parse(cursor):upper-5*60000;
 const behind=upper-last;
 if(behind>30*86400000)return {status:"requires_historical_backfill",range:null};
 if(behind<=0)return {status:"current",range:null};
 const since=Math.max(last-120000,upper-30*86400000);
 // Five-minute bounded chunks with a two-minute replay overlap.
 const until=Math.min(upper,Math.max(last, since)+5*60000);
 if(until<=since)return {status:"current",range:null};
 return {status:behind>60*60000?"recoverable_backlog":"behind",
   range:{since:new Date(since),until:new Date(until)}};
}
export function scheduleRefreshWindow(now:Date,timezone:string,horizonDays:number):{
 since:Date;until:Date
} {
 const horizon=Math.min(21,Math.max(1,Math.trunc(horizonDays)));
 const day=formatInTimeZone(now,timezone,"yyyy-MM-dd");
 const start=parseISO(day);
 // Includes recent corrections, today and configurable future schedule.
 const since=fromZonedTime(addDays(start,-3).toISOString().slice(0,10)+"T00:00:00",timezone);
 const until=fromZonedTime(addDays(start,horizon+2).toISOString().slice(0,10)+"T00:00:00",timezone);
 if(until.getTime()-since.getTime()>30*86400000)throw new ToastApiError("invalid_response");
 return {since,until};
}
export async function pollToastLocation(db:SupabaseClient,p:ToastPollParams,now=new Date()) {
 if(!GUID.safeParse(p.businessId).success||!GUID.safeParse(p.locationId).success||
    !GUID.safeParse(p.restaurantGuid).success)
   throw new ToastApiError("invalid_response");
 const [{data:location,error:locError},{data:business,error:busError}]=await Promise.all([
  db.from("locations").select("business_id,open_hours").eq("id",p.locationId)
    .eq("business_id",p.businessId).maybeSingle(),
  db.from("businesses").select("timezone,is_demo").eq("id",p.businessId).maybeSingle(),
 ]);
 if(locError||busError||!location||!business||business.is_demo)
    throw new ToastApiError("unauthorized_location");
 // Future shifts have to be refreshed BEFORE opening time. Labor/order polling
 // remains subject to the explicit configured open-hours policy.
 if(p.kind!=="schedules"&&!isCafeCurrentlyOpen(location.open_hours,business.timezone,now))
    return {skipped:"outside_configured_hours",fetched:0};
 const {data:lease,error:leaseError}=await db.rpc("toast_claim_poll",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_kind:p.kind
 });
 if(leaseError)throw new ToastApiError("unavailable");
 if(!lease)return {skipped:"leased_or_not_verified",fetched:0};
 let failure:string|null=null,retryAt:string|null=null,until:string|null=null,fetched=0;
 let freshness:PollFreshness="current";
 try {
  const {data:health,error:healthError}=await db.from("toast_sync_health")
    .select("last_order_poll_at,last_time_entry_poll_at,last_schedule_poll_at")
    .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
  if(healthError)throw new ToastApiError("unavailable");
  if(p.kind==="schedules"){
    const configured=Number(process.env.TOAST_SCHEDULE_HORIZON_DAYS??"14");
    const range=scheduleRefreshWindow(now,business.timezone,Number.isFinite(configured)?configured:14);
    const result=await syncToastLaborReadOnly(db,p,range,"schedules");
    fetched=result.staged;
    until=now.toISOString(); // freshness timestamp, not a future schedule boundary
  }else{
    const cursor=p.kind==="orders"?health?.last_order_poll_at:health?.last_time_entry_poll_at;
    const planned=planModifiedWindow(cursor??null,now);
    freshness=planned.status;
    if(planned.range){
      const range=planned.range;
      if(p.kind==="orders"){
        const adapter=createToastAdapter({db,businessId:p.businessId,restaurantGuid:p.restaurantGuid});
        const facts=await adapter.fetchModifiedOrderStates(range);
        // Prevent a hot function with thousands of sequential database writes.
        // Do not advance a cursor when work cannot be staged in this invocation.
        if(facts.length>50)throw new ToastApiError("invalid_response");
        for(const fact of facts){
          const {error:save}=await db.rpc("toast_store_order_fact",{
            p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
            p_order_guid:fact.orderGuid,p_modified_at:fact.modifiedAt,
            p_state:fact.state,p_normalized_order:fact.normalizedOrder,
            p_event_guid:null
          });
          if(save)throw new ToastApiError("unavailable");
        }
        fetched=facts.length;
      }else{
        // Modified-time query covers corrections to older clock-ins and archived entries.
        const result=await syncToastLaborReadOnly(db,p,range,"attendance","modified");
        fetched=result.staged;
      }
      // Cursor advances only after all pages and every staging batch has succeeded.
      until=range.until.toISOString();
    }
  }
 }catch(error){
   failure=error instanceof ToastApiError?error.category:"unavailable";
   retryAt=orderEventRetryAt(error,2);
 }finally{
   const {data:finished,error:finishError}=await db.rpc("toast_finish_poll",{
    p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
    p_kind:p.kind,p_nonce:lease,p_cursor_at:until,
    p_success:failure===null,p_retry_after:retryAt,p_failure:failure
   });
   if(finishError||!finished)throw new ToastApiError("unavailable");
 }
 if(failure)throw new ToastApiError(failure as ToastApiError["category"],undefined,retryAt??undefined);
 return {fetched,staged_only:true,freshness,
   ...(freshness==="requires_historical_backfill"?{requiresHistoricalBackfill:true}:{}),
   nextCursor:until};
}
