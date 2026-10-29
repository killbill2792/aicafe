import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fromZonedTime} from "date-fns-tz";
import {addCalendarDays} from "./scheduleDates";
import {copyToastAttendance,type ToastCopyScope} from "./operationalCopy";
import {ToastApiError} from "./client";

const DAY_MS=86400000;
type Params=ToastCopyScope&{timeZone:string};
type Chunk=(db:SupabaseClient,p:ToastCopyScope,
 range:{since:Date;until:Date})=>Promise<unknown>;
/** Read only recorded sales coverage. A change in this historical range does
 * not invalidate earlier completed labor chunks or fabricate timecards. */
export async function backfillToastStoredLabor(db:SupabaseClient,p:Params,
 deadlineAt:number,syncChunk:Chunk=copyToastAttendance,maxChunks=3){
 const base=()=>db.from("toast_day_status").select("business_date")
  .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
  .eq("import_state","imported");
 const [first,last,progress]=await Promise.all([
  base().order("business_date",{ascending:true}).limit(1).maybeSingle(),
  base().order("business_date",{ascending:false}).limit(1).maybeSingle(),
  db.from("toast_labor_backfill_progress").select("next_at,covered_from")
   .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid).maybeSingle()
 ]);
 if(first.error||last.error||progress.error)throw new ToastApiError("unavailable");
 if(!first.data?.business_date||!last.data?.business_date)
  return {chunks:0,complete:true,nextAt:null};
 const begin=fromZonedTime(first.data.business_date+"T00:00:00",p.timeZone);
 const end=fromZonedTime(addCalendarDays(last.data.business_date,1)+"T00:00:00",p.timeZone);
 let cursor=progress.data?.next_at?new Date(progress.data.next_at):begin;
 if(!Number.isFinite(cursor.getTime())||cursor<begin)cursor=begin;
 // Start of the range already read. Older rows have none: their range began at the
 // first imported day, so only a later backward extension of history is new.
 const savedFrom=(progress.data as {covered_from?:string|null}|null)?.covered_from;
 let lower=savedFrom?new Date(savedFrom):progress.data?.next_at?begin:null;
 if(lower&&(!Number.isFinite(lower.getTime())||lower>cursor))lower=cursor;
 const save=async(next:Date,from:Date|null)=>{
  const {error}=await db.from("toast_labor_backfill_progress").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   next_at:next.toISOString(),covered_from:(from??begin).toISOString(),updated_at:new Date().toISOString()
  },{onConflict:"business_id,restaurant_guid"});
  if(error)throw new ToastApiError("unavailable");
 };
 let chunks=0;
 // History the owner added before the covered range: fill it backwards so the
 // covered range stays contiguous and a failed chunk is retried, not skipped.
 while(lower&&lower.getTime()>begin.getTime()&&chunks<maxChunks&&Date.now()<deadlineAt){
  const since=new Date(Math.max(lower.getTime()-30*DAY_MS,begin.getTime()));
  await syncChunk(db,p,{since,until:lower});
  await save(cursor,since);
  chunks++;lower=since;
 }
 while(cursor.getTime()<end.getTime()&&chunks<maxChunks&&Date.now()<deadlineAt){
  const until=new Date(Math.min(cursor.getTime()+30*DAY_MS,end.getTime()));
  // A failed chunk is NOT checkpointed. The next tick retries it idempotently.
  await syncChunk(db,p,{since:cursor,until});
  await save(until,lower);
  chunks++;cursor=until;
 }
 const earlierDone=!lower||lower.getTime()<=begin.getTime();
 return {chunks,complete:earlierDone&&cursor.getTime()>=end.getTime(),nextAt:cursor.toISOString()};
}
