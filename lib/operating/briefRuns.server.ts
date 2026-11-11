import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";

/** Every brief outcome, above all every skip, is recorded with its step and
 * reason (AGENTS.md §4c: a silent skip is a P1). One row per café, local day,
 * owner, channel and run kind (migration 148); the latest step wins.
 * A persistence failure is logged with a redacted reason and rejected to the
 * producer, so a log-only record can never be reported as durable success.
 * Never names, phone numbers, message text or tokens: ids, steps and reasons. */
export type BriefRunOutcome="sent"|"queued"|"waiting"|"skipped"|"failed";
export type BriefRunRecord={
  businessId:string;localDate:string;ownerKey:string;
  channel:"in_app"|"whatsapp";runKind:"scheduled"|"test";
  step:string;outcome:BriefRunOutcome;reason:string;details?:Record<string,unknown>;
};
export type BriefRunWriteOptions={preserveExisting?:boolean;finalMissed?:boolean};
export const CAFE_OWNER_KEY="cafe";

const errorCode=(error:unknown):string|null=>{
  if(typeof error==="object"&&error!==null&&"code" in error&&
    typeof (error as {code?:unknown}).code==="string")return (error as {code:string}).code;
  return null;
};

export async function recordBriefRun(db:SupabaseClient,r:BriefRunRecord,now=new Date(),
  options:BriefRunWriteOptions={}):Promise<void>{
  const row={business_id:r.businessId,local_date:r.localDate,owner_key:r.ownerKey,
    channel:r.channel,run_kind:r.runKind,step:r.step.slice(0,64),outcome:r.outcome,
    reason:r.reason.slice(0,200),details:r.details??{},updated_at:now.toISOString()};
  const conflict="business_id,local_date,owner_key,channel,run_kind";
  try{
    if(options.finalMissed){
      const existing=await db.from("morning_brief_runs").select("outcome,reason")
        .eq("business_id",r.businessId).eq("local_date",r.localDate)
        .eq("owner_key",r.ownerKey).eq("channel",r.channel).eq("run_kind",r.runKind)
        .maybeSingle();
      if(existing.error)throw existing.error;
      // A successful/queued delivery is never overwritten by a later cron tick.
      // The final missed outcome itself is also immutable once recorded.
      if(existing.data&&(existing.data.outcome==="sent"||existing.data.outcome==="queued"||
        existing.data.reason==="missed_send_window"))return;
    }
    const writeOptions:{onConflict:string;ignoreDuplicates?:boolean}={onConflict:conflict};
    if(options.preserveExisting)writeOptions.ignoreDuplicates=true;
    const {error}=await db.from("morning_brief_runs").upsert(row,writeOptions);
    if(error)throw error;
  }catch(error){
    console.warn("morning_brief_run",{...row,recorded:"failed",code:errorCode(error)});
    throw new Error("brief_run_persistence_failed");
  }
}

export type BriefRunRow={businessId:string;localDate:string;ownerKey:string;channel:string;
  runKind:string;step:string;outcome:string;reason:string;details:unknown;updatedAt:string};
/** Admin only (service role). Missing table = migration 148 not applied. */
export function briefRunsSince(days=3,now=new Date()):string{
  return new Date(now.getTime()-days*86_400_000).toISOString().slice(0,10);
}
export async function readRecentBriefRuns(db:SupabaseClient,sinceDate:string):
  Promise<{available:boolean;rows:BriefRunRow[]}>{
  const {data,error}=await db.from("morning_brief_runs")
    .select("business_id,local_date,owner_key,channel,run_kind,step,outcome,reason,details,updated_at")
    .gte("local_date",sinceDate).order("local_date",{ascending:false})
    .order("updated_at",{ascending:false}).limit(500);
  if(error)return {available:false,rows:[]};
  return {available:true,rows:(data??[]).map(r=>({businessId:r.business_id,localDate:r.local_date,
    ownerKey:r.owner_key,channel:r.channel,runKind:r.run_kind,step:r.step,outcome:r.outcome,
    reason:r.reason,details:r.details,updatedAt:r.updated_at}))};
}
