import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {normalizeOpenHours,OPEN_HOURS_DAY_KEYS,type OpenHours} from "@/lib/business/openHours";
import {createToastAdapter} from "./adapter";
import {syncToastLaborReadOnly} from "./laborSync";
import {GUID,ToastApiError} from "./client";
import {orderEventRetryAt} from "./orderQueue";
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
function windowFrom(cursor:string|null,now:Date) {
 const untilMs=now.getTime()-120000;
 const requestedSince=cursor?Date.parse(cursor)-120000:untilMs-30*60000;
 const sinceMs=Math.max(Number.isFinite(requestedSince)?requestedSince:untilMs-30*60000,
   untilMs-30*86400000);
 if(sinceMs>=untilMs) return null;
 // One bounded 30-minute chunk; the cursor advances only on a fully successful read.
 return {since:new Date(sinceMs),until:new Date(Math.min(untilMs,sinceMs+30*60000))};
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
 if(!isCafeCurrentlyOpen(location.open_hours,business.timezone,now))
    return {skipped:"outside_configured_hours",fetched:0};
 const {data:lease,error:leaseError}=await db.rpc("toast_claim_poll",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_kind:p.kind
 });
 if(leaseError)throw new ToastApiError("unavailable");
 if(!lease)return {skipped:"leased_or_not_verified",fetched:0};
 let failure:string|null=null,retryAt:string|null=null,until:string|null=null,fetched=0;
 try {
  const {data:health,error:healthError}=await db.from("toast_sync_health")
    .select("last_order_poll_at,last_time_entry_poll_at,last_schedule_poll_at")
    .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
  if(healthError)throw new ToastApiError("unavailable");
  const cursor=p.kind==="orders"?health?.last_order_poll_at:
    p.kind==="attendance"?health?.last_time_entry_poll_at:health?.last_schedule_poll_at;
  const range=windowFrom(cursor??null,now);
  if(!range)return {skipped:"already_current",fetched:0};
  until=range.until.toISOString();
  if(p.kind==="orders"){
   const adapter=createToastAdapter({db,businessId:p.businessId,restaurantGuid:p.restaurantGuid});
   const orders=await adapter.fetchModifiedOrders(range);
   const rows=orders.map(order=>{
     const orderGuid=order.posOrderId.split(":").at(-1)??"";
     if(!GUID.safeParse(orderGuid).success)throw new ToastApiError("invalid_response");
     return {business_id:p.businessId,restaurant_guid:p.restaurantGuid,order_guid:orderGuid,
       normalized_order:order,state:"completed",last_checked_at:new Date().toISOString()};
   });
   // Bound Supabase round trips independently of order count.
   for(let offset=0;offset<rows.length;offset+=100) {
     const {error:saveError}=await db.from("toast_modified_orders_staging")
       .upsert(rows.slice(offset,offset+100),
         {onConflict:"business_id,restaurant_guid,order_guid"});
     if(saveError)throw new ToastApiError("unavailable");
   }
   fetched=orders.length;
  }else{
   const result=await syncToastLaborReadOnly(db,p,range,p.kind);
   fetched=result.staged;
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
 return {fetched,staged_only:true,nextCursor:until};
}
