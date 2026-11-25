import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {fromZonedTime} from "date-fns-tz";
import {createToastClient,ToastApiError,toToastTimestamp} from "./client";
import {ingestToastOrderRevision} from "./orderIngestion";
import {orderEventRetryAt} from "./orderQueue";
import {isCafeCurrentlyOpen} from "./poll";
import {currentToastBusinessDay} from "./todaySoFar";
import {addCalendarDays} from "./scheduleDates";

const MINUTE=60000;
export const orderRecoveryCadence=(open:boolean,webhookSeen:boolean)=>
 (open&&!webhookSeen?10:60)*MINUTE;

/** A committed modification-time cursor, independent of the order's business
 * date. Do not discard a gap after a long outage. Replay a short overlap; the
 * common order writer deduplicates old revisions. No moving seven-day window. */
export function orderRecoveryWindow(cursor:string|null,bootstrap:Date,now:Date){
 const end=now.getTime()-2*MINUTE;
 const previous=cursor?Date.parse(cursor):bootstrap.getTime();
 if(!Number.isFinite(previous)||!Number.isFinite(end))throw new ToastApiError("invalid_response");
 if(previous>=end)return null;
 return {since:new Date(previous-2*MINUTE),until:new Date(Math.min(end,previous+60*MINUTE))};
}
type Params={businessId:string;restaurantGuid:string;locationId:string};
export async function pollToastOrderRevisions(db:SupabaseClient,p:Params,now=new Date(),deadlineAt=Date.now()+60000){
 const [{data:m,error:me},{data:l,error:le},{data:h,error:he}]=await Promise.all([
  db.from("toast_location_mappings").select("toast_time_zone,closeout_hour,verified_at")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).eq("location_id",p.locationId).maybeSingle(),
  db.from("locations").select("open_hours").eq("business_id",p.businessId).eq("id",p.locationId).maybeSingle(),
  db.from("toast_sync_health").select("last_order_poll_at").eq("business_id",p.businessId)
   .eq("restaurant_guid",p.restaurantGuid).maybeSingle()
 ]);
 if(me||le||he)throw new ToastApiError("unavailable");
 if(!m?.verified_at||!m.toast_time_zone||m.closeout_hour==null||!l)throw new ToastApiError("unauthorized_location");
 const scope={businessId:p.businessId,restaurantGuid:p.restaurantGuid,timezone:m.toast_time_zone,closeoutHour:m.closeout_hour};
 const cursor=h?.last_order_poll_at as string|null|undefined;
 let webhookSeen=false;
 if(process.env.TOAST_WEBHOOKS_ENABLED==="true"&&process.env.TOAST_JOBS_ENABLED==="true"){
  const [subscription,event]=await Promise.all([
   db.from("toast_webhook_subscriptions").select("id").eq("business_id",p.businessId).eq("enabled",true).limit(1),
   db.from("toast_order_events").select("event_guid").eq("business_id",p.businessId)
    .eq("restaurant_guid",p.restaurantGuid).eq("state","complete").limit(1)
  ]);
  if(subscription.error||event.error)throw new ToastApiError("unavailable");
  webhookSeen=Boolean(subscription.data?.length&&event.data?.length);
 }
 const open=isCafeCurrentlyOpen(l.open_hours,scope.timezone,now);
 if(cursor&&now.getTime()-Date.parse(cursor)<orderRecoveryCadence(open,webhookSeen))
  return {skipped:"not_due",fetched:0};
 const {data:lease,error:claimError}=await db.rpc("toast_claim_poll",{p_business_id:p.businessId,
  p_restaurant_guid:p.restaurantGuid,p_kind:"orders"});
 if(claimError)throw new ToastApiError("unavailable");
 if(!lease)return {skipped:"leased_or_not_verified",fetched:0};
 const budget=Math.min(deadlineAt,Date.now()+60000);
 let failure:unknown=null,until:string|null=null,fetched=0;
 try{
  // On first activation cover the previous and current provider business
  // days. The existing daily reconciliation remains the completeness backstop.
  const day=addCalendarDays(currentToastBusinessDay(now,scope.timezone,scope.closeoutHour),-1);
  const bootstrap=fromZonedTime(day+"T"+String(scope.closeoutHour).padStart(2,"0")+":00:00",scope.timezone);
  // Re-read the cursor after acquiring the lease, never use a stale snapshot.
  const {data:latest,error}=await db.from("toast_sync_health").select("last_order_poll_at")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle();
  if(error)throw new ToastApiError("unavailable");
  const window=orderRecoveryWindow(latest?.last_order_poll_at??null,bootstrap,now);
  if(window){
   const client=createToastClient(db,p.businessId);
   for(let page=1;;page++){
    if(Date.now()>=budget)throw new ToastApiError("timeout");
    const rows=await client.request("/orders/v2/ordersBulk?startDate="+toToastTimestamp(window.since)+
     "&endDate="+toToastTimestamp(window.until)+"&pageSize=100&page="+page,
     p.restaurantGuid,z.array(z.unknown()),{deadlineAt:budget});
    if(rows.length>100)throw new ToastApiError("invalid_response");
    for(const row of rows){
     if(Date.now()>=budget)throw new ToastApiError("timeout");
     await ingestToastOrderRevision(db,scope,row,now);fetched++;
    }
    if(rows.length<100){until=window.until.toISOString();break;}
   }
  }
 }catch(e){failure=e;}
 // An interrupted window is replayed, never certified complete. Existing
 // per-object idempotency and active repair dedupe make replays safe.
 const category=failure instanceof ToastApiError?failure.category:failure?"unavailable":null;
 const {data:finished,error:finishError}=await db.rpc("toast_finish_poll",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_kind:"orders",p_nonce:lease,
  p_cursor_at:failure?null:until,p_success:failure===null,
  p_retry_after:failure?orderEventRetryAt(failure,2):null,p_failure:category});
 if(finishError||!finished)throw new ToastApiError("unavailable");
 if(failure)throw failure;
 return {fetched,completedWindow:until!==null,nextCursor:until};
}
