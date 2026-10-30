import type {SupabaseClient} from "@supabase/supabase-js";
import {ToastApiError} from "./client";
import {addCalendarDays} from "./scheduleDates";

/** Finds Toast days that are missing or incomplete and re-pulls only those
 * days, a few per hour, newest first. A day is missing when it has no import,
 * a failed import, an incomplete import, or orders but no saved payments (so
 * no card fees). Re-tries wait longer each time instead of re-pulling every
 * hour: 1h after the first try in the last three days, then 2h, 4h, 8h,
 * 16h, and at most once a day. A day already queued or running is left alone. */
export const MISSING_DAY_LOOKBACK_DAYS=84;
export const MISSING_DAYS_PER_RUN=5;
const RETRY_WINDOW_MS=72*3600_000;
const MAX_WAIT_MS=24*3600_000;
const ACTIVE=new Set(["queued","running","paused_rate_limited"]);

export type MissingReason="not_imported"|"incomplete"|"no_fees";
type DayRow={business_date:string;import_state:string;order_count:number|null;
 coverage_complete:boolean|null;unparsed_count:number|null};
type RunRow={requested_from:string|null;requested_to:string|null;state:string;started_at:string|null};

/** How long to wait after the latest try, given the tries in the last three days. */
export function retryWaitMs(triesInWindow:number){
 if(triesInWindow<=0)return 0;
 return Math.min(MAX_WAIT_MS,3600_000*2**(triesInWindow-1));
}

/** Days the café should have, newest first, with why each one needs a pull.
 * Pure. Today belongs to the live reading; an unimported yesterday belongs to
 * the daily import, which runs after closeout. */
export function missingDayCandidates(days:DayRow[],today:string,withPayments:Set<string>|null){
 const byDate=new Map(days.map(d=>[d.business_date,d]));
 const first=[...byDate.keys()].sort()[0];
 const out:Array<{date:string;reason:MissingReason}>=[];
 if(!first)return out;
 const yesterday=addCalendarDays(today,-1);
 for(let date=yesterday;date>=first;date=addCalendarDays(date,-1)){
  const d=byDate.get(date);
  if(!d||d.import_state!=="imported"){if(date<yesterday)out.push({date,reason:"not_imported"});}
  else if(d.coverage_complete===false||Number(d.unparsed_count??0)>0)out.push({date,reason:"incomplete"});
  else if(Number(d.order_count)>0&&withPayments&&!withPayments.has(date))out.push({date,reason:"no_fees"});
 }
 return out;
}

/** Whether a day may be re-pulled now, from the import runs that covered it. */
export function mayRetryDay(date:string,runs:RunRow[],now:number){
 const covering=runs.filter(r=>r.requested_from!==null&&r.requested_from<=date&&
  (r.requested_to??r.requested_from)>=date);
 if(covering.some(r=>ACTIVE.has(r.state)))return false;
 const tries=covering.map(r=>r.started_at?Date.parse(r.started_at):NaN)
  .filter(t=>Number.isFinite(t)&&now-t<RETRY_WINDOW_MS);
 if(!tries.length)return true;
 return now-Math.max(...tries)>=retryWaitMs(tries.length);
}

export async function queueToastMissingDays(db:SupabaseClient,
 m:{business_id:string;restaurant_guid:string},today:string,deadlineAt:number,now=Date.now()){
 const from=addCalendarDays(today,-MISSING_DAY_LOOKBACK_DAYS);
 const {data:days,error}=await db.from("toast_day_status")
  .select("business_date,import_state,order_count,coverage_complete,unparsed_count")
  .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
  .gte("business_date",from).lt("business_date",today)
  .order("business_date",{ascending:false}).limit(MISSING_DAY_LOOKBACK_DAYS+1);
 if(error)throw new ToastApiError("unavailable");
 // No imported history yet: the first backfill owns the café's start.
 if(!days?.length)return [];
 const {data:runs,error:runError}=await db.from("toast_sync_runs")
  .select("requested_from,requested_to,state,started_at")
  .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
  .in("kind",["daily","backfill","repull_modified"]).gte("requested_to",from)
  .order("requested_from",{ascending:false}).limit(1000);
 if(runError)throw new ToastApiError("unavailable");
 const queued:Array<{date:string;reason:MissingReason}>=[];
 // Payments are counted only for imported days that pass the retry check.
 for(const candidate of missingDayCandidates(days as DayRow[],today,null)
  .concat(await daysWithoutPayments(db,m,days as DayRow[],today,(runs??[]) as RunRow[],now,deadlineAt))
  .sort((a,b)=>b.date.localeCompare(a.date))){
  if(queued.length>=MISSING_DAYS_PER_RUN||Date.now()>=deadlineAt)break;
  if(!mayRetryDay(candidate.date,(runs??[]) as RunRow[],now))continue;
  const {error:queueError}=await db.rpc("toast_queue_owner_repull",{
   p_business_id:m.business_id,p_restaurant_guid:m.restaurant_guid,p_date:candidate.date});
  if(queueError)throw new ToastApiError("unavailable");
  queued.push(candidate);
 }
 return queued;
}

async function daysWithoutPayments(db:SupabaseClient,m:{business_id:string;restaurant_guid:string},
 days:DayRow[],today:string,runs:RunRow[],now:number,deadlineAt:number){
 const out:Array<{date:string;reason:MissingReason}>=[];
 const complete=days.filter(d=>d.import_state==="imported"&&d.coverage_complete!==false&&
  !(Number(d.unparsed_count??0)>0)&&Number(d.order_count)>0)
  .sort((a,b)=>b.business_date.localeCompare(a.business_date));
 for(const day of complete){
  if(out.length>=MISSING_DAYS_PER_RUN||Date.now()>=deadlineAt)break;
  if(!mayRetryDay(day.business_date,runs,now))continue;
  const {count,error}=await db.from("toast_payment_facts")
   .select("payment_ref",{count:"exact",head:true})
   .eq("business_id",m.business_id).eq("restaurant_guid",m.restaurant_guid)
   .eq("business_date",day.business_date);
  if(error)throw new ToastApiError("unavailable");
  if((count??0)===0)out.push({date:day.business_date,reason:"no_fees"});
 }
 return out;
}
