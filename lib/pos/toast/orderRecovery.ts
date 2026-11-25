import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {fromZonedTime} from "date-fns-tz";
import {createToastClient,ToastApiError,toToastTimestamp} from "./client";
import {prepareToastOrderRevision} from "./orderIngestion";
import {orderEventRetryAt} from "./orderQueue";
import {isCafeCurrentlyOpen} from "./poll";
import {currentToastBusinessDay} from "./todaySoFar";
import {addCalendarDays,localClock} from "./scheduleDates";
import {normalizeOpenHours,OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";

const MINUTE=60000;
export const orderRecoveryCadence=(open:boolean,_webhookSeen:boolean)=>
 (open?5:30)*MINUTE;

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
  db.from("toast_sync_health").select("canonical_order_poll_at,canonical_live_day").eq("business_id",p.businessId)
   .eq("restaurant_guid",p.restaurantGuid).maybeSingle()
 ]);
 if(me||le||he)throw new ToastApiError("unavailable");
 if(!m?.verified_at||!m.toast_time_zone||m.closeout_hour==null||!l)throw new ToastApiError("unauthorized_location");
 const scope={businessId:p.businessId,restaurantGuid:p.restaurantGuid,timezone:m.toast_time_zone,closeoutHour:m.closeout_hour};
 const cursor=h?.canonical_order_poll_at as string|null|undefined;
 const hours=normalizeOpenHours(l.open_hours);
 const open=!hours||!Object.prototype.hasOwnProperty.call(hours,OPEN_HOURS_DAY_KEYS[new Date(Date.parse(localClock(now,scope.timezone).today+"T12:00:00Z")).getUTCDay()])||isCafeCurrentlyOpen(hours,scope.timezone,now);
 const liveDay=currentToastBusinessDay(now,scope.timezone,scope.closeoutHour);
 if(h?.canonical_live_day===liveDay&&cursor&&now.getTime()-Date.parse(cursor)<orderRecoveryCadence(open,false))
  return {skipped:"not_due",fetched:0};
 const {data:lease,error:claimError}=await db.rpc("toast_claim_poll",{p_business_id:p.businessId,
  p_restaurant_guid:p.restaurantGuid,p_kind:"orders"});
 if(claimError)throw new ToastApiError("unavailable");
 if(!lease)return {skipped:"leased_or_not_verified",fetched:0};
 const budget=Math.min(deadlineAt,Date.now()+60000);
 let failure:unknown=null,until:string|null=null,fetched=0;
 try{
  const day=liveDay;
  const bootstrap=fromZonedTime(day+"T"+String(scope.closeoutHour).padStart(2,"0")+":00:00",scope.timezone);
  const client=createToastClient(db,p.businessId);
  while(Date.now()<budget){
   const [{data:latest,error},{data:progress,error:pe}]=await Promise.all([
    db.from("toast_sync_health").select("canonical_order_poll_at,canonical_live_day")
     .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle(),
    db.from("toast_order_poll_progress").select("window_since,window_until,next_page,bootstrap_day")
     .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).eq("canonical",true).maybeSingle()
   ]);
   if(error||pe)throw new ToastApiError("unavailable");
   const bootDay=progress?progress.bootstrap_day:latest?.canonical_live_day!==day?day:null;
   // A complete business-day seed is needed once on a new day, including
   // orders opened before closeout. Subsequent updates use modification time.
   const window=progress?{since:new Date(progress.window_since),until:new Date(progress.window_until)}:
    bootDay?{since:new Date(Math.min(bootstrap.getTime(),now.getTime()-2*MINUTE)),until:now}:
    orderRecoveryWindow(latest?.canonical_order_poll_at??null,bootstrap,now);
   if(!window)break;
   if(window.since>=window.until)throw new ToastApiError("invalid_response");
   const page=progress?.next_page??1;
   const query=bootDay?"businessDate="+String(bootDay).replaceAll("-",""):
    "startDate="+toToastTimestamp(window.since)+"&endDate="+toToastTimestamp(window.until);
   const rows=await client.request("/orders/v2/ordersBulk?"+query+"&pageSize=100&page="+page,
    p.restaurantGuid,z.array(z.unknown()),{deadlineAt:budget});
   if(rows.length>100)throw new ToastApiError("invalid_response");
   const prepared=rows.map(row=>prepareToastOrderRevision(scope,row));
   if(bootDay&&prepared.some(row=>row.day!==bootDay))throw new ToastApiError("invalid_response");
   const {data:receipt,error:writeError}=await db.rpc("toast_commit_canonical_order_page",{
    p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_nonce:lease,
    p_since:window.since.toISOString(),p_until:window.until.toISOString(),p_page:page,
    p_rows:prepared,p_has_more:rows.length===100,p_bootstrap_day:bootDay});
   if(writeError||typeof receipt?.changed!=="number"||typeof receipt?.complete!=="boolean")throw new ToastApiError("unavailable");
   fetched+=rows.length;
   if(receipt.complete&&!bootDay)until=window.until.toISOString();
   if(receipt.complete&&!bootDay&&window.until.getTime()>=now.getTime()-2*MINUTE)break;
  }

 }catch(e){failure=e;}
 // An interrupted window is replayed, never certified complete. Existing
 // per-object idempotency and active repair dedupe make replays safe.
 const category=failure instanceof ToastApiError?failure.category:failure?"unavailable":null;
 const {data:finished,error:finishError}=await db.rpc("toast_finish_poll",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_kind:"orders",p_nonce:lease,
  p_cursor_at:null,p_success:failure===null,
  p_retry_after:failure?orderEventRetryAt(failure,2):null,p_failure:category});
 if(finishError||!finished)throw new ToastApiError("unavailable");
 if(failure)throw failure;
 return {fetched,completedWindow:until!==null,nextCursor:until};
}
