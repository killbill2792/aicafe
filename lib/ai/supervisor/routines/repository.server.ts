import "server-only";
import {z} from "zod";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {routineIdSchema,routineScheduleSchema,routineStatusSchema,
  type RoutineRecord,type RoutineSchedule,type VerifiedRoutineTurn} from "./contracts";

type RoutineRow={
  business_id:string;id:string;owner_user_id:string;thread_id:string;
  title:string;cadence:"daily"|"weekly";weekdays:number[];local_time:string;
  timezone:string;status:RoutineRecord["status"];revision:number;
  created_at:string;updated_at:string;
  execution_mode?:"priority"|"objective"|"watch";
  objective_text?:string|null;objective_source_message_id?:string|null;
  objective_updates?:unknown;
};
const asRoutine=(r:RoutineRow):RoutineRecord=>({
  id:r.id,businessId:r.business_id,ownerUserId:r.owner_user_id,threadId:r.thread_id,
  title:r.title,cadence:r.cadence,weekdays:r.weekdays,
  localTime:String(r.local_time).slice(0,5),timezone:r.timezone,
  status:r.status,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,
  executionMode:r.execution_mode??"priority",objectiveText:r.objective_text??null,
  objectiveSourceMessageId:r.objective_source_message_id??null,
  objectiveUpdates:Array.isArray(r.objective_updates)?r.objective_updates.filter(v=>
    v&&typeof v==="object"&&typeof v.sourceMessageId==="string"&&
    typeof v.text==="string"&&Number.isSafeInteger(v.revision)):[],
});
function checkedTurn(turn:VerifiedRoutineTurn):VerifiedRoutineTurn{
  const threadId=routineIdSchema.parse(turn.threadId);
  if(!turn.scope.businessId||!turn.scope.ownerUserId||threadId!==turn.threadId)
    throw new Error("Routine owner scope unavailable");
  return turn;
}
export async function createOwnerRoutine(schedule:RoutineSchedule,turn:VerifiedRoutineTurn):
  Promise<RoutineRecord>{
  checkedTurn(turn);
  const parsed=routineScheduleSchema.parse(schedule);
  // A retry of the same verified owner turn + schedule must not double-create.
  const hash=turn.ownerMessageId?createHash("sha256").update(
    turn.scope.businessId+":"+turn.scope.ownerUserId+":"+turn.threadId+":"+
    turn.ownerMessageId+":"+JSON.stringify(parsed)).digest("hex"):null;
  const stableId=hash?(hash.slice(0,8)+"-"+hash.slice(8,12)+"-4"+
    hash.slice(13,16)+"-a"+hash.slice(17,20)+"-"+hash.slice(20,32)):null;
  const u4Enabled=process.env.SUPERVISOR_U4_ENABLED==="true";
  const {data,error}=await turn.client.rpc(u4Enabled&&turn.ownerMessageId?
    "u4_create_objective_routine":"create_supervisor_routine",{
    p_business_id:turn.scope.businessId,p_owner_user_id:turn.scope.ownerUserId,
    p_thread_id:turn.threadId,p_title:parsed.title,p_cadence:parsed.cadence,
    p_weekdays:parsed.weekdays,p_local_time:parsed.localTime,p_routine_id:stableId,
    ...(u4Enabled&&turn.ownerMessageId?{p_owner_message_id:turn.ownerMessageId}:{}),
  });
  if(error||!data)throw error??new Error("Routine not saved");
  return asRoutine(data as RoutineRow);
}
const routineReadFields="business_id,id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status,revision,created_at,updated_at,execution_mode,objective_text,objective_source_message_id,objective_updates";
/** One canonical RLS-backed reader for thread-only and café-wide owner views. */
async function readOwnerRoutines(scope:VerifiedRoutineTurn["scope"],client:SupabaseClient,threadId?:string){
  const base=client.from("supervisor_routines").select(routineReadFields)
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId);
  const query=threadId?base.eq("thread_id",threadId):base;
  const {data,error}=await query.order("created_at",{ascending:false}).limit(100);
  if(error&&["PGRST204","42703"].includes(error.code??"")){
    // Rolling U4 app code must not break existing routines before its additive
    // migration has been applied. Never silently bypass a different DB error.
    const legacy=await (threadId?client.from("supervisor_routines")
      .select("business_id,id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status,revision,created_at,updated_at")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",threadId):
      client.from("supervisor_routines")
      .select("business_id,id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status,revision,created_at,updated_at")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId))
      .order("created_at",{ascending:false}).limit(100);
    if(legacy.error)throw legacy.error;
    return ((legacy.data??[]) as RoutineRow[]).map(asRoutine);
  }
  if(error)throw error;
  // System-origin Watch uses the SAME schedule/occurrence ledger but must
  // never appear as an owner-created routine in the simple chat list.
  return ((data??[]) as RoutineRow[]).filter(r=>r.execution_mode!=="watch").map(asRoutine);
}
export async function listOwnerRoutines(turn:VerifiedRoutineTurn):Promise<RoutineRecord[]>{
  checkedTurn(turn);
  return readOwnerRoutines(turn.scope,turn.client,turn.threadId);
}
export async function listOwnerRoutinesAcrossThreads(scope:VerifiedRoutineTurn["scope"],client:SupabaseClient):Promise<RoutineRecord[]>{
  if(!scope.businessId||!scope.ownerUserId)throw new Error("Routine owner scope unavailable");
  return readOwnerRoutines(scope,client);
}
export async function changeOwnerRoutine(input:{
  id:string;revision:number;status?:RoutineRecord["status"];
  schedule?:RoutineSchedule;
},turn:VerifiedRoutineTurn):Promise<RoutineRecord>{
  checkedTurn(turn);
  const id=routineIdSchema.parse(input.id);
  const revision=z.number().int().positive().parse(input.revision);
  const status=input.status===undefined?undefined:routineStatusSchema.parse(input.status);
  const schedule=input.schedule===undefined?undefined:routineScheduleSchema.parse(input.schedule);
  if(!status&&!schedule)throw new Error("Routine change required");
  const u4Edit=process.env.SUPERVISOR_U4_ENABLED==="true"&&Boolean(turn.ownerMessageId&&schedule);
  const {data,error}=await turn.client.rpc(u4Edit?
    "u4_edit_objective_routine":"change_supervisor_routine",{
    p_business_id:turn.scope.businessId,p_owner_user_id:turn.scope.ownerUserId,
    p_thread_id:turn.threadId,p_routine_id:id,p_revision:revision,
    ...(u4Edit?{p_owner_message_id:turn.ownerMessageId}:{}),
    p_patch:{...(status?{status}:{}),...(schedule??{})},
  });
  if(error||!data)throw error??new Error("Routine change rejected");
  return asRoutine(data as RoutineRow);
}
/** Bounded candidates from current revision and durable occurrence identities. */
export async function listRoutineOccurrenceCandidates(db:SupabaseClient,params:{
  businessId:string;routineId:string;revision:number;now:Date
}):Promise<{localDate:string;scheduledForUtc:string|null}[]>{
  const {data,error}=await db.rpc("supervisor_due_routine_dates",{
    p_business_id:params.businessId,p_routine_id:params.routineId,
    p_revision:params.revision,p_now:params.now.toISOString(),
  });
  if(error)throw error;
  return z.array(z.object({
    local_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    scheduled_for_utc:z.string().nullable(),
  })).max(5).parse(data).map(row=>({
    localDate:row.local_date,scheduledForUtc:row.scheduled_for_utc,
  }));
}
export type ClaimedRoutine={runId:string;leaseToken:string;revision:number};
export async function claimRoutineOccurrence(db:SupabaseClient,params:{
  businessId:string;routineId:string;revision:number;localDate:string;dueAt:Date;now:Date
}):Promise<ClaimedRoutine|null>{
  const {data,error}=await db.rpc("supervisor_claim_current_routine_occurrence",{
    p_business_id:params.businessId,p_routine_id:params.routineId,
    p_revision:params.revision,p_local_date:params.localDate,p_scheduled_for_utc:params.dueAt.toISOString(),
    p_now:params.now.toISOString(),
  });
  if(error)throw error;
  if(!data)return null;
  const row=data as {run_id:string;lease_token:string;revision:number};
  return {runId:row.run_id,leaseToken:row.lease_token,revision:row.revision};
}
export async function finishRoutineOccurrence(db:SupabaseClient,params:{
  businessId:string;routineId:string;runId:string;leaseToken:string;
  success:boolean;receiptRef:string;now:Date;
}):Promise<boolean>{
  const {data,error}=await db.rpc("finish_supervisor_routine_occurrence",{
    p_business_id:params.businessId,p_routine_id:params.routineId,
    p_run_id:params.runId,p_lease_token:params.leaseToken,
    p_success:params.success,p_receipt_ref:params.receiptRef.slice(0,160),
    p_now:params.now.toISOString(),
  });
  if(error)throw error;
  return data===true;
}
