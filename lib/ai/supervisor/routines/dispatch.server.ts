import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {localDateAt,dueScheduleOnDate} from "./calendar";
import {choosePriorities} from "./priority";
import {claimRoutineOccurrence,finishRoutineOccurrence} from "./repository.server";
import {postPriorityNotice} from "./notices.server";
import type {PriorityDecision,PrioritySource,RoutineRecord} from "./contracts";

export type RoutineDispatchResult={
  routinesChecked:number;runs:number;notices:number;failed:number;
  evidenceChecks:number;
};
type DbRow={id:string;[field:string]:unknown};
const batchLimit=100;
type Scope={businessId:string;ownerUserId:string;threadId:string;localDate:string};
function safeSeverity(payload:unknown):string|null{
  if(!payload||typeof payload!=="object")return null;
  const severity=(payload as Record<string,unknown>).severity;
  return severity==="critical"||severity==="high"?severity:null;
}
/** Read existing authoritative alert/task rows; do NOT use cached café money or
 * infer that a missing/failed provider is a verified zero. */
export async function readActionablePriorities(db:SupabaseClient,scope:Scope,
  now:Date):Promise<PriorityDecision[]>{
  const [alerts,tasks]=await Promise.all([
    db.from("alerts").select("id,kind,status,payload,created_at")
      .eq("business_id",scope.businessId).in("status",["new","seen"])
      .order("created_at",{ascending:false}).limit(batchLimit),
    db.from("operating_tasks")
      .select("id,kind,status,due_at,confidence,evidence,created_at,owner_user_id")
      .eq("business_id",scope.businessId)
      .in("status",["needs_owner","needs_response"])
      .neq("kind","priority_notice")
      .or("owner_user_id.is.null,owner_user_id.eq."+scope.ownerUserId)
      .order("created_at",{ascending:false}).limit(batchLimit),
  ]);
  if(alerts.error||tasks.error)throw alerts.error??tasks.error;
  const sources:PrioritySource[]=[];
  for(const raw of (alerts.data??[]) as DbRow[]){
    const payload=raw.payload as Record<string,unknown>|null;
    sources.push({
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,
      sourceType:"alert",sourceId:String(raw.id),kind:String(raw.kind),
      status:String(raw.status),createdAt:String(raw.created_at),
      severity:safeSeverity(payload),
      dedupeKey:typeof payload?.dedupeKey==="string"?payload.dedupeKey:null,
      evidence:payload??null,
    });
  }
  for(const raw of (tasks.data??[]) as DbRow[]){
    if(raw.owner_user_id&&raw.owner_user_id!==scope.ownerUserId)continue;
    sources.push({
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,
      sourceType:"operating_task",sourceId:String(raw.id),
      kind:String(raw.kind),status:String(raw.status),
      dueAt:typeof raw.due_at==="string"?raw.due_at:null,
      confidence:typeof raw.confidence==="string"?raw.confidence:null,
      createdAt:String(raw.created_at),evidence:raw.evidence??null,
    });
  }
  return choosePriorities(sources,now,3);
}
async function postForOwner(db:SupabaseClient,scope:Scope,now:Date,
  opts?:{routine:{id:string;runId:string;leaseToken:string}},
):Promise<{posted:number;checked:number}>{
  const priorities=await readActionablePriorities(db,scope,now);
  let posted=0;
  for(const decision of priorities){
    const outcome=await postPriorityNotice(db,{...scope,...opts},decision,now);
    if(outcome==="posted")posted++;
  }
  return {posted,checked:priorities.length};
}
type RoutineRow={
  business_id:string;id:string;owner_user_id:string;thread_id:string;
  title:string;cadence:"daily"|"weekly";weekdays:number[];
  local_time:string;timezone:string;status:"active"|"paused"|"revoked";
  revision:number;created_at:string;updated_at:string;
};
function parseRoutine(row:RoutineRow):RoutineRecord{
  return {
    businessId:row.business_id,id:row.id,ownerUserId:row.owner_user_id,threadId:row.thread_id,
    title:row.title,cadence:row.cadence,weekdays:row.weekdays,
    localTime:String(row.local_time).slice(0,5),timezone:row.timezone,
    status:row.status,revision:row.revision,
    createdAt:row.created_at,updatedAt:row.updated_at,
  };
}
type OwnerScope={ownerUserId:string;threadId:string};
/** The existing refresh-derived cron calls this once per café *after* alert
 * generation. Any owner with an existing thread receives change-driven notices,
 * even on dates where no routine is due. No new AI worker, event loop or inbox. */
export async function dispatchRoutinesForBusiness(db:SupabaseClient,businessId:string,
  timezone:string,now:Date):Promise<RoutineDispatchResult>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid routine now");
  const localDate=localDateAt(now,timezone);
  const result:RoutineDispatchResult={routinesChecked:0,runs:0,notices:0,failed:0,evidenceChecks:0};
  const [ownerRows,threadRows,routineRows]=await Promise.all([
    db.from("memberships").select("user_id").eq("business_id",businessId)
      .eq("role","owner").order("user_id",{ascending:true}).limit(batchLimit),
    db.from("ai_threads").select("id,owner_user_id").eq("business_id",businessId)
      .order("updated_at",{ascending:false}).limit(batchLimit*2),
    db.from("supervisor_routines").select("business_id,id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status,revision,created_at,updated_at")
      .eq("business_id",businessId).eq("status","active")
      .order("created_at",{ascending:true}).limit(batchLimit),
  ]);
  if(ownerRows.error||threadRows.error||routineRows.error)
    throw ownerRows.error??threadRows.error??routineRows.error;
  const owners=new Set((ownerRows.data??[]).map(row=>row.user_id));
  const threads=new Map<string,string>();
  for(const row of threadRows.data??[]){
    if(owners.has(row.owner_user_id)&&!threads.has(row.owner_user_id))
      threads.set(row.owner_user_id,row.id);
  }
  const routines=((routineRows.data??[]) as RoutineRow[]).map(parseRoutine);
  // Source-change notices remain independent from the due schedule.
  for(const ownerUserId of owners){
    const threadId=threads.get(ownerUserId);
    if(!threadId){result.failed++;continue;}
    try{
      const done=await postForOwner(db,{businessId,ownerUserId,threadId,localDate},now);
      result.evidenceChecks+=done.checked;
      result.notices+=done.posted;
    }catch{result.failed++;}
  }
  for(const routine of routines){
    result.routinesChecked++;
    if(!owners.has(routine.ownerUserId)||routine.timezone!==timezone){
      result.failed++;continue;
    }
    let lease:{runId:string;leaseToken:string;revision:number}|null=null;
    try{
      const due=dueScheduleOnDate(routine,routine.timezone,localDate,now);
      if(!due)continue;
      lease=await claimRoutineOccurrence(db,{businessId,routineId:routine.id,
        localDate,dueAt:due,now});
      if(!lease)continue;
      // A routine check is an internal read/notice operation; never start a
      // synthetic owner turn or send an external provider effect.
      const done=await postForOwner(db,{
        businessId,ownerUserId:routine.ownerUserId,threadId:routine.threadId,
        localDate,
      },now,{routine:{id:routine.id,runId:lease.runId,leaseToken:lease.leaseToken}});
      const finished=await finishRoutineOccurrence(db,{
        businessId,routineId:routine.id,runId:lease.runId,
        leaseToken:lease.leaseToken,success:true,
        receiptRef:"priority-check:"+done.checked,now:new Date(),
      });
      if(!finished)throw new Error("Routine lease lost before completion");
      result.runs++;
      result.notices+=done.posted;
      result.evidenceChecks+=done.checked;
    }catch{
      result.failed++;
      if(lease){
        try{
          await finishRoutineOccurrence(db,{
            businessId,routineId:routine.id,runId:lease.runId,
            leaseToken:lease.leaseToken,success:false,
            receiptRef:"bounded_check_failed",now:new Date(),
          });
        }catch{result.failed++;}
      }
    }
  }
  return result;
}
