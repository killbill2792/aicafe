import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import type {ConversationScope} from "@/lib/ai/conversations/contracts";
import {readPersistedOperatingTasks} from "@/lib/data/operatingTasks";
import {notifyOwner} from "./notifyOwner.server";

const titleSchema=z.string().trim().min(1).max(240);
const localDate=z.iso.date();
const localTime=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).nullable();

export type CommitmentOrigin="owner_chat"|"supervisor_followup";
export type CommitmentInput={
  threadId:string;title:string;origin:CommitmentOrigin;
  dueDate:string;dueTime:string|null;
};
/** Supplied only by the already-authorized Supervisor turn, never model input. */
export type VerifiedCommitmentTurn={scope:ConversationScope;threadId:string;client:SupabaseClient};
export type CommitmentView={
  id:string;title:string;status:"watching"|"needs_owner"|"handled";
  dueDate:string;dueTime:string|null;timezone:string;origin:CommitmentOrigin;
};

/** Only the authenticated owner can create or close commitments from chat.
 * The Postgres functions independently enforce that the thread belongs to this owner. */
export async function createOwnerCommitment(input:CommitmentInput,turn:VerifiedCommitmentTurn):Promise<CommitmentView>{
  const title=titleSchema.parse(input.title);
  const date=localDate.parse(input.dueDate);
  const time=localTime.parse(input.dueTime);
  const threadId=z.uuid().parse(turn.threadId);
  if(input.threadId!==threadId)throw new Error("Commitment thread scope mismatch");
  const origin=z.enum(["owner_chat","supervisor_followup"]).parse(input.origin);
  const {scope,client:db}=turn;
  const {data,error}=await db.rpc("create_operating_commitment",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
    p_thread_id:threadId,p_title:title,p_origin:origin,
    p_due_date:date,p_due_time:time,
  });
  if(error||!data)throw error??new Error("Commitment was not saved");
  const row=data as {id:string;status:CommitmentView["status"];payload:{title:string};
    due_local_date:string;due_local_time:string|null;due_timezone:string;origin:CommitmentOrigin};
  return {id:row.id,title:row.payload.title,status:row.status,dueDate:row.due_local_date,
    dueTime:row.due_local_time,timezone:row.due_timezone,origin:row.origin};
}

export async function closeOwnerCommitment(taskId:string,turn:VerifiedCommitmentTurn):Promise<boolean>{
  const id=z.string().min(1).max(160).parse(taskId);
  const {scope,client:db}=turn;
  const {data,error}=await db.rpc("close_operating_commitment",{
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_task_id:id,
  });
  if(error)throw error;
  return data===true;
}

/** Uses the ONE canonical operating_tasks reader. Reopening chat never writes. */
export async function listOwnerCommitments(turn:VerifiedCommitmentTurn):Promise<CommitmentView[]>{
  const {scope,client}=turn;
  const tasks=await readPersistedOperatingTasks(scope.businessId,{
    client,businessId:scope.businessId,ownerUserId:scope.ownerUserId,
  });
  return tasks.filter(t=>t.kind==="commitment"&&t.ownerUserId===scope.ownerUserId)
    .map(t=>({id:t.id,title:String(t.payload.title??""),status:t.status as CommitmentView["status"],
      dueDate:t.dueLocalDate??"",dueTime:t.dueLocalTime??null,
      timezone:t.dueTimezone??"",origin:t.origin??"owner_chat"}));
}

type DueRow={id:string;payload:{threadId?:string};due_local_date:string};
/** Called by an existing trusted scheduler with a verified café and owner scope.
 * The notification gateway decides; the RPC atomically claims the due task and
 * writes its private chat message, so a retry cannot notify twice.
 * A failed RPC rolls back both writes and is safe to retry. */
export async function deliverDueCommitments(
  db:SupabaseClient,scope:{businessId:string;ownerUserId:string},now:Date
):Promise<{delivered:number;remaining:number;failed:number}>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid due-check instant");
  const {data,error}=await db.from("operating_tasks")
    .select("id,payload,due_local_date").eq("business_id",scope.businessId)
    .eq("owner_user_id",scope.ownerUserId).eq("kind","commitment")
    .eq("status","watching").lte("due_at",now.toISOString())
    .order("due_at",{ascending:true}).limit(50);
  if(error)throw error;
  let delivered=0,failed=0;
  for(const row of (data??[]) as DueRow[]){
    try{
    const threadId=row.payload.threadId;
    if(!threadId)throw new Error("Commitment thread missing");
    const notice=await notifyOwner(db,{
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,threadId,
      taskId:row.id,kind:"commitment",localDate:row.due_local_date,
      important:true,required:true,
    },async()=>{
      const outcome=await db.rpc("deliver_due_operating_commitment",{
        p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
        p_task_id:row.id,p_now:now.toISOString(),
      });
      if(outcome.error)throw outcome.error;
      return outcome.data===true;
    });
    if(notice.result===true)delivered++;
    }catch{failed++;}
  }
  return {delivered,remaining:Math.max(0,(data??[]).length-delivered),failed};
}


/** The existing 15-minute derived-refresh cron calls this for every café. It
 * discovers only due commitments and groups them by the persisted owner scope.
 * A failed scope stays pending and is retried on the next cron; others proceed. */
export async function deliverPendingCommitments(db:SupabaseClient,now:Date):
  Promise<{scopes:number;delivered:number;failed:number}>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid due-check instant");
  const {data,error}=await db.from("operating_tasks")
    .select("business_id,owner_user_id").eq("kind","commitment").eq("status","watching")
    .lte("due_at",now.toISOString()).order("due_at",{ascending:true}).limit(200);
  if(error)throw error;
  const scopes=new Map<string,{businessId:string;ownerUserId:string}>();
  for(const row of data??[]){
    if(!row.owner_user_id)throw new Error("Due commitment missing owner");
    const key=row.business_id+":"+row.owner_user_id;
    if(!scopes.has(key))scopes.set(key,{businessId:row.business_id,ownerUserId:row.owner_user_id});
  }
  let delivered=0,failed=0;
  for(const scope of scopes.values()){
    try{
      const result=await deliverDueCommitments(db,scope,now);
      delivered+=result.delivered;
      failed+=result.failed;
    }catch{
      failed++;
      // Do not swallow the failure as success: the cron reports it and SQL kept the
      // task watching, so the next scheduled run can safely try again.
    }
  }
  return {scopes:scopes.size,delivered,failed};
}
