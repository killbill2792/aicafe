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
export type PollFreshness="current"|"behind"|"recoverable_backlog"|"requires_historical_backfill"|"backfilling"|"failed"|"rate_limited";
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

type Range={since:Date;until:Date};
type RecoveryRow={
 state:"requires_historical_backfill"|"backfilling"|"failed"|"complete";
 missing_since:string;missing_until:string;next_since:string;last_failure_category:string|null
};
type PageProgress={window_since:string;window_until:string;next_page:number;is_recovery:boolean};
export function planRecoveryWindow(
 recovery:Pick<RecoveryRow,"next_since"|"missing_until">,kind:"orders"|"attendance"
):Range {
 const start=Date.parse(recovery.next_since),end=Date.parse(recovery.missing_until);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)
   throw new ToastApiError("invalid_response");
 // Each invocation is bounded to one page or one attendance window.
 // These intervals are far shorter than Toast's maximum 30-day range.
 const length=kind==="orders"?3*3600000:3600000;
 return {since:new Date(start),until:new Date(Math.min(end,start+length))};
}
function checkedProgress(row:PageProgress):{range:Range;page:number;recovery:boolean} {
 const range={since:new Date(row.window_since),until:new Date(row.window_until)};
 if(!Number.isFinite(range.since.getTime())||!Number.isFinite(range.until.getTime())||
   range.until<=range.since||row.next_page<1||row.next_page>1000)
   throw new ToastApiError("invalid_response");
 return {range,page:row.next_page,recovery:row.is_recovery};
}
/** Every OrdersBulk page and its durable checkpoint commit atomically in SQL.
 * One invocation = <=100 provider facts, one provider request, one database RPC. */
export async function stageToastOrderPollPage(db:SupabaseClient,p:ToastPollParams,
 nonce:string,range:Range,page:number,isRecovery:boolean) {
 const adapter=createToastAdapter({db,businessId:p.businessId,restaurantGuid:p.restaurantGuid});
 const response=await adapter.fetchModifiedOrderStatesPage(range,page);
 if(response.facts.length>100||(response.hasMore&&response.facts.length!==100))
   throw new ToastApiError("invalid_response");
 const {data,error}=await db.rpc("toast_stage_order_poll_page",{
   p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_nonce:nonce,
   p_since:range.since.toISOString(),p_until:range.until.toISOString(),
   p_page:page,p_facts:response.facts,p_has_more:response.hasMore,
   p_is_recovery:isRecovery,
 });
 if(error||!data||typeof data.complete!=="boolean")throw new ToastApiError("unavailable");
 return {fetched:response.facts.length,complete:data.complete as boolean,
   nextCursor:data.complete?range.until.toISOString():null,
   nextPage:response.hasMore?page+1:null};
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
 if(p.kind!=="schedules"&&!isCafeCurrentlyOpen(location.open_hours,business.timezone,now))
    return {skipped:"outside_configured_hours",fetched:0};
 const {data:lease,error:leaseError}=await db.rpc("toast_claim_poll",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,p_kind:p.kind
 });
 if(leaseError)throw new ToastApiError("unavailable");
 if(!lease)return {skipped:"leased_or_not_verified",fetched:0};
 let failure:string|null=null,retryAt:string|null=null,until:string|null=null,fetched=0;
 let freshness:PollFreshness="current",leaseFinished=false;
 let isRecovering=false,completedWindow=false,nextPage:number|null=null;
 let missingPeriod:{since:string;until:string}|null=null;
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
    until=now.toISOString();
  }else{
    const cursor=p.kind==="orders"?health?.last_order_poll_at:health?.last_time_entry_poll_at;
    const recoveryQuery=await db.from("toast_poll_recovery")
      .select("state,missing_since,missing_until,next_since,last_failure_category")
      .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
      .eq("kind",p.kind).maybeSingle();
    if(recoveryQuery.error)throw new ToastApiError("unavailable");
    let recovery=recoveryQuery.data as RecoveryRow|null;
    const progressQuery=p.kind==="orders"?await db.from("toast_order_poll_progress")
      .select("window_since,window_until,next_page,is_recovery")
      .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
      .maybeSingle():null;
    if(progressQuery?.error)throw new ToastApiError("unavailable");
    const progress=progressQuery?.data as PageProgress|null|undefined;
    let range:Range|null=null,page=1;
    if(progress){
      ({range,page,recovery:isRecovering}=checkedProgress(progress));
      freshness=isRecovering?"backfilling":"recoverable_backlog";
    }else if(recovery&&recovery.state!=="complete"){
      isRecovering=true;
      freshness=recovery.state==="failed"?"failed":recovery.state==="requires_historical_backfill"
        ?"requires_historical_backfill":"backfilling";
      range=planRecoveryWindow(recovery,p.kind);
    }else{
      const planned=planModifiedWindow(cursor??null,now);
      freshness=planned.status;
      if(planned.status==="requires_historical_backfill"){
        const upper=new Date(now.getTime()-120000).toISOString();
        const {data:created,error}=await db.rpc("toast_begin_poll_recovery",{
          p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
          p_kind:p.kind,p_nonce:lease,p_until:upper,
        });
        if(error||!created)throw new ToastApiError("unavailable");
        const after=await db.from("toast_poll_recovery")
          .select("state,missing_since,missing_until,next_since,last_failure_category")
          .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
          .eq("kind",p.kind).single();
        if(after.error||!after.data)throw new ToastApiError("unavailable");
        recovery=after.data as RecoveryRow;
        isRecovering=true;
        range=planRecoveryWindow(recovery,p.kind);
      }else{
        range=planned.range;
      }
    }
    if(isRecovering&&recovery)missingPeriod={
      since:recovery.missing_since,until:recovery.missing_until};
    if(range){
      if(p.kind==="orders"){
        const result=await stageToastOrderPollPage(db,p,lease,range,page,isRecovering);
        fetched=result.fetched;until=result.nextCursor;nextPage=result.nextPage;
        completedWindow=result.complete;leaseFinished=true; // RPC includes nonce-fenced finish.
      }else{
        const result=await syncToastLaborReadOnly(db,p,range,"attendance","modified");
        fetched=result.staged;
        if(isRecovering){
          const {data:finished,error}=await db.rpc("toast_complete_attendance_recovery",{
           p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
           p_nonce:lease,p_since:range.since.toISOString(),p_until:range.until.toISOString(),
          });
          if(error||!finished)throw new ToastApiError("unavailable");
          leaseFinished=true;
        }
        completedWindow=true;until=range.until.toISOString();
      }
    }
  }
 }catch(error){
   failure=error instanceof ToastApiError?error.category:"unavailable";
   retryAt=orderEventRetryAt(error,2);
   if(isRecovering&&!leaseFinished){
     const {error:markError}=await db.rpc("toast_mark_poll_recovery_failure",{
       p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
       p_kind:p.kind,p_nonce:lease,p_failure:failure,
     });
     if(markError)throw new ToastApiError("unavailable");
   }
 }finally{
   if(!leaseFinished){
     const {data:finished,error:finishError}=await db.rpc("toast_finish_poll",{
       p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
       p_kind:p.kind,p_nonce:lease,p_cursor_at:failure?null:until,
       p_success:failure===null,p_retry_after:retryAt,p_failure:failure
     });
     if(finishError||!finished)throw new ToastApiError("unavailable");
   }
 }
 if(failure)throw new ToastApiError(failure as ToastApiError["category"],undefined,retryAt??undefined);
 return {fetched,staged_only:true,freshness,completedWindow,nextPage,
   ...(missingPeriod?{missingPeriod}:{}),nextCursor:until};
}
