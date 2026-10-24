import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {formatInTimeZone} from "date-fns-tz";
import {importToastBusinessDay} from "./dayImport";
import {refreshToastRestaurantInfo} from "./restaurantInfo";
import {createToastClient,ToastApiError,toToastTimestamp} from "./client";
import {retryPendingToastRollups} from "./rollupRefreshWorker";
import {z} from "zod";

type Mapping={business_id:string;location_id:string;restaurant_guid:string;
 toast_time_zone:string;closeout_hour:number;info_refreshed_at:string|null;
 verified_at:string|null;scopes_available?:Record<string,boolean>};
type Run={id:string;kind:string;state:string;requested_from:string|null;
 requested_to:string|null;days_done:number;days_total:number;
 cursor:Record<string,unknown>|null;resume_at:string|null};
export const TICK_MS=240000;
const DAY=86400000;
const isoDay=(d:Date)=>d.toISOString().slice(0,10);
export const addCalendarDays=(day:string,days:number)=>
 isoDay(new Date(Date.parse(day+"T12:00:00Z")+days*DAY));
export function localClock(now:Date,timeZone:string){
 const local=formatInTimeZone(now,timeZone,"yyyy-MM-dd HH:mm:ss");
 return {today:local.slice(0,10),minutes:Number(local.slice(11,13))*60+Number(local.slice(14,16))};
}
export function eligibleClosedDay(now:Date,timeZone:string,closeoutHour:number){
 const t=localClock(now,timeZone);
 return t.minutes>=((closeoutHour+1)*60)
  ?addCalendarDays(t.today,-1):null;
}
export function deriveNextRunDay(run:Pick<Run,"requested_from"|"days_done"|"requested_to">){
 if(!run.requested_from)return null;
 const day=addCalendarDays(run.requested_from,run.days_done);
 return !run.requested_to||day<=run.requested_to?day:null;
}
function mustFinish(deadlineAt:number){
 if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
}
function providerFailure(e:unknown){
 return e instanceof ToastApiError?e.category:"unavailable";
}
function shouldResume(r:Run,now:number){
 return ["queued","running","paused_rate_limited"].includes(r.state)&&
  (!r.resume_at||Date.parse(r.resume_at)<=now);
}
async function runDue(db:SupabaseClient,m:Mapping,run:Run,deadlineAt:number){
 let completed=0;
 const maxDays=run.kind==="backfill"?5:1;
 for(let count=0;count<maxDays;count++){
  mustFinish(deadlineAt);
  const day=deriveNextRunDay(run);
  if(!day||run.days_total>0&&run.days_done>=run.days_total)break;
  try {
   await importToastBusinessDay(db,{businessId:m.business_id,
    locationId:m.location_id,restaurantGuid:m.restaurant_guid,businessDate:day,
    runId:run.id,deadlineAt});
   completed++;
  }catch(e){
   // invalid_response is an individual day's failure. The SQL error RPC
   // advances exactly one day and resets the page cursor, so proceed.
   if(providerFailure(e)!=="invalid_response")break;
   completed++;
  }
  const {data:updated,error}=await db.from("toast_sync_runs")
   .select("id,kind,state,requested_from,requested_to,days_done,days_total,cursor,resume_at")
   .eq("id",run.id).single();
  if(error||!updated)throw new ToastApiError("unavailable");
  run=updated as Run;
  if(run.state==="completed"||run.state==="failed")break;
  if(run.kind==="backfill"&&count+1<maxDays){
   // Leave a 5s gap between completed historical business-day pulls.
   const remaining=deadlineAt-Date.now();
   if(remaining<=5000)break;
   await new Promise(resolve=>setTimeout(resolve,5000));
  }
 }
 return completed;
}
async function queueDaily(db:SupabaseClient,m:Mapping,day:string){
 const {data:existing,error}=await db.from("toast_day_status")
  .select("import_state").eq("business_id",m.business_id)
  .eq("restaurant_guid",m.restaurant_guid).eq("business_date",day).maybeSingle();
 if(error)throw new ToastApiError("unavailable");
 if(existing?.import_state==="imported")return;
 const {error:queued}=await db.rpc("toast_queue_daily",{
  p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,p_date:day
 });
 if(queued)throw new ToastApiError("unavailable");
}
async function queueFirstBackfill(db:SupabaseClient,m:Mapping,now:Date){
 const {data,error}=await db.from("toast_sync_runs").select("id")
  .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
  .eq("kind","backfill").limit(1);
 if(error)throw new ToastApiError("unavailable");
 if(data?.length)return;
 const today=localClock(now,m.toast_time_zone).today;
 const {error:queued}=await db.rpc("toast_queue_backfill",{
  p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,
  p_from:addCalendarDays(today,-84),p_to:addCalendarDays(today,-1)
 });
 if(queued)throw new ToastApiError("unavailable");
}
async function scanModifiedDates(db:SupabaseClient,m:Mapping,now:Date,deadlineAt:number){
 const clock=localClock(now,m.toast_time_zone);
 if(clock.minutes<(m.closeout_hour+6)*60)return;
 const {data:last,error}=await db.from("toast_repull_scan_state")
  .select("last_local_day").eq("business_id",m.business_id)
  .eq("restaurant_guid",m.restaurant_guid).maybeSingle();
 if(error)throw new ToastApiError("unavailable");
 if(last?.last_local_day===clock.today)return;
 const configured=Number(process.env.TOAST_REPULL_DAYS??7);
 const days=Number.isInteger(configured)?Math.min(30,Math.max(1,configured)):7;
 const client=createToastClient(db,m.business_id);
 const end=now.getTime();
 const discovered=new Set<string>();
 for(let windowStart=end-days*DAY;windowStart<end;){
  mustFinish(deadlineAt);
  const windowEnd=Math.min(end,windowStart+7*DAY);
  for(let page=1;page<=300;page++){
   mustFinish(deadlineAt);
   const path="/orders/v2/ordersBulk?startDate="+toToastTimestamp(new Date(windowStart))+
    "&endDate="+toToastTimestamp(new Date(windowEnd))+"&pageSize=100&page="+page;
   const rows=await client.request(path,m.restaurant_guid,z.array(z.unknown()),{deadlineAt});
   if(rows.length>100)throw new ToastApiError("invalid_response");
   for(const o of rows){
    if(typeof o!=="object"||o===null)throw new ToastApiError("invalid_response");
    const date=(o as {businessDate?:unknown}).businessDate;
    if(typeof date!=="number"||!Number.isInteger(date))throw new ToastApiError("invalid_response");
    const txt=String(date);
    if(!/^20\\d{6}$/.test(txt))throw new ToastApiError("invalid_response");
    const iso=txt.slice(0,4)+"-"+txt.slice(4,6)+"-"+txt.slice(6);
    if(Number.isNaN(Date.parse(iso+"T12:00:00Z")))throw new ToastApiError("invalid_response");
    discovered.add(iso);
   }
   if(rows.length<100)break;
   if(page===300)throw new ToastApiError("invalid_response");
  }
  windowStart=windowEnd;
 }
 // Scan marker and all affected whole-day runs commit together. A crash before
 // this RPC simply scans again; a crash after it resumes the queued day runs.
 const {error:queued}=await db.rpc("toast_commit_repull_scan",{
  p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,
  p_local_day:clock.today,p_days:[...discovered].sort(),
  p_window_end:now.toISOString()
 });
 if(queued)throw new ToastApiError("unavailable");
}
export async function runToastSyncTick(db:SupabaseClient,now=new Date(),
 deadlineAt=Date.now()+TICK_MS){
 if(process.env.TOAST_AUTO_IMPORT_ENABLED!=="true")return {disabled:true};
 const {data:mappings,error}=await db.from("toast_location_mappings")
  .select("business_id,location_id,restaurant_guid,toast_time_zone,closeout_hour,info_refreshed_at,verified_at")
  .not("verified_at","is",null).order("business_id").limit(100);
 if(error)throw new ToastApiError("unavailable");
 let acquired=0,processed=0,errors=0;
 for(const m of (mappings??[]) as Mapping[]){
  if(Date.now()>=deadlineAt)break;
  if(!m.toast_time_zone||m.closeout_hour==null)continue;
  const {data:nonce,error:leaseError}=await db.rpc("toast_acquire_lease",{
   p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,p_seconds:290});
  if(leaseError){errors++;continue;}
  if(!nonce)continue;
  acquired++;
  try {
   if(!m.info_refreshed_at||Date.parse(m.info_refreshed_at)<now.getTime()-DAY)
    await refreshToastRestaurantInfo(db,m.business_id,m.restaurant_guid,{deadlineAt});
   mustFinish(deadlineAt);
   // A committed import's failed cost refresh is never another order import.
   await retryPendingToastRollups(db,{businessId:m.business_id,limit:5,deadlineAt});
   // Resume paused/running runs first. A day after toast_import_day is derived
   // from requested_from+days_done, NOT from the cleared JSON cursor.
   const {data:pending,error:pErr}=await db.from("toast_sync_runs")
    .select("id,kind,state,requested_from,requested_to,days_done,days_total,cursor,resume_at")
    .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
    .in("state",["queued","running","paused_rate_limited"])
    .order("requested_from").limit(100);
   if(pErr)throw new ToastApiError("unavailable");
   const resumes=((pending??[]) as Run[]).filter(r=>shouldResume(r,Date.now()));
   for(const run of resumes.filter(r=>r.state!=="queued")){
    if(Date.now()>=deadlineAt)break;
    processed+=await runDue(db,m,run,deadlineAt);
   }
   const closed=eligibleClosedDay(now,m.toast_time_zone,m.closeout_hour);
   if(closed)await queueDaily(db,m,closed);
   if(Date.now()<deadlineAt)await scanModifiedDates(db,m,now,deadlineAt);
   if(Date.now()<deadlineAt)await queueFirstBackfill(db,m,now);
   const {data:next,error:nextErr}=await db.from("toast_sync_runs")
    .select("id,kind,state,requested_from,requested_to,days_done,days_total,cursor,resume_at")
    .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
    .eq("state","queued").order("requested_from").limit(100);
   if(nextErr)throw new ToastApiError("unavailable");
   const sorted=((next??[]) as Run[]).sort((a,b)=>{
    const priority=(k:string)=>k==="daily"?0:k==="repull_modified"?1:k==="backfill"?3:2;
    return priority(a.kind)-priority(b.kind)||(a.requested_from??"").localeCompare(b.requested_from??"");
   });
   for(const run of sorted){
    if(Date.now()>=deadlineAt)break;
    processed+=await runDue(db,m,run,deadlineAt);
   }
  }catch{errors++;}
  finally{
   // Never leak the nonce or delete a different worker's lease.
   await db.rpc("toast_release_lease",{p_nonce:nonce});
  }
 }
 return {acquired,processed,errors};
}
