import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {routineIdSchema,routineScheduleSchema,routineStatusSchema,
  type RoutineRecord,type RoutineSchedule,type VerifiedRoutineTurn} from "./contracts";

type RoutineRow={
  business_id:string;id:string;owner_user_id:string;thread_id:string;
  title:string;cadence:"daily"|"weekly";weekdays:number[];local_time:string;
  timezone:string;status:RoutineRecord["status"];revision:number;
  created_at:string;updated_at:string;
};
const asRoutine=(r:RoutineRow):RoutineRecord=>({
  id:r.id,businessId:r.business_id,ownerUserId:r.owner_user_id,threadId:r.thread_id,
  title:r.title,cadence:r.cadence,weekdays:r.weekdays,
  localTime:String(r.local_time).slice(0,5),timezone:r.timezone,
  status:r.status,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,
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
  const {data,error}=await turn.client.rpc("create_supervisor_routine",{
    p_business_id:turn.scope.businessId,p_owner_user_id:turn.scope.ownerUserId,
    p_thread_id:turn.threadId,p_title:parsed.title,p_cadence:parsed.cadence,
    p_weekdays:parsed.weekdays,p_local_time:parsed.localTime,
  });
  if(error||!data)throw error??new Error("Routine not saved");
  return asRoutine(data as RoutineRow);
}
export async function listOwnerRoutines(turn:VerifiedRoutineTurn):Promise<RoutineRecord[]>{
  checkedTurn(turn);
  const {data,error}=await turn.client.from("supervisor_routines")
    .select("business_id,id,owner_user_id,thread_id,title,cadence,weekdays,local_time,timezone,status,revision,created_at,updated_at")
    .eq("business_id",turn.scope.businessId).eq("owner_user_id",turn.scope.ownerUserId)
    .eq("thread_id",turn.threadId).order("created_at",{ascending:false}).limit(100);
  if(error)throw error;
  return ((data??[]) as RoutineRow[]).map(asRoutine);
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
  const {data,error}=await turn.client.rpc("change_supervisor_routine",{
    p_business_id:turn.scope.businessId,p_owner_user_id:turn.scope.ownerUserId,
    p_thread_id:turn.threadId,p_routine_id:id,p_revision:revision,
    p_patch:{...(status?{status}:{}),...(schedule??{})},
  });
  if(error||!data)throw error??new Error("Routine change rejected");
  return asRoutine(data as RoutineRow);
}
export type ClaimedRoutine={runId:string;leaseToken:string;revision:number};
export async function claimRoutineOccurrence(db:SupabaseClient,params:{
  businessId:string;routineId:string;localDate:string;dueAt:Date;now:Date
}):Promise<ClaimedRoutine|null>{
  const {data,error}=await db.rpc("claim_supervisor_routine_occurrence",{
    p_business_id:params.businessId,p_routine_id:params.routineId,
    p_local_date:params.localDate,p_scheduled_for_utc:params.dueAt.toISOString(),
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
