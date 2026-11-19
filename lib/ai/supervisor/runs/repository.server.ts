import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  decodeClaim, decodeRun, runScopeSchema, stepSpecSchema,
  type DurableRunRepository, type RunScope, type StepClaim, type StepSpec,
  type DurableRun, ownerRunInputSchema, checkpointRowSchema, type OwnerRunInput, type CheckpointRow, type OwnerRunCheckpoint,
} from "./contracts";

const uuid = z.uuid();
const shortRef = z.string().min(1).max(256);
const lease = z.number().int().min(1).max(3600);

function parseIdentity(scope: RunScope, runId: string) {
  return { scope: runScopeSchema.parse(scope), runId: uuid.parse(runId) };
}
async function callRpc<T>(name: string, params: Record<string, unknown>, decode: (v: unknown) => T): Promise<T> {
  const { data, error } = await createAdminSupabaseClient().rpc(name, params);
  if (error) throw new Error("Supervisor durable run storage unavailable", { cause: error });
  return decode(data);
}

/** All state transitions are atomic, service-role-only SQL RPCs.
 * Never point this repository at ai_agent_jobs: that table owns chat turns. */
export class SupabaseDurableRunRepository implements DurableRunRepository {
  async start(scope: RunScope, requestKey: string, steps: readonly StepSpec[]): Promise<DurableRun> {
    const s = runScopeSchema.parse(scope);
    const key = uuid.parse(requestKey);
    const parsed = z.array(stepSpecSchema).min(1).max(32).parse(steps);
    if (new Set(parsed.map(step => step.key)).size !== parsed.length)
      throw new Error("Duplicate Supervisor run step");
    // The ordered step contract is immutable for any retried request key.
    const planHash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const result = await callRpc("supervisor_run_start", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_request_key: key,
      p_plan_hash: planHash, p_steps: parsed,
    }, decodeRun);
    if (result.businessId !== s.businessId || result.ownerUserId !== s.ownerUserId ||
      result.threadId !== s.threadId || result.requestKey !== key)
      throw new Error("Supervisor run outside owner scope");
    return result;
  }

  claim(scope: RunScope, runId: string, workerId: string, leaseSeconds: number): Promise<StepClaim> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    return callRpc("supervisor_run_claim", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id,
      p_worker_id: uuid.parse(workerId), p_lease_seconds: lease.parse(leaseSeconds),
    }, decodeClaim);
  }

  renew(scope: RunScope, runId: string, key: string, token: string, leaseSeconds: number): Promise<boolean> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    return callRpc("supervisor_run_renew", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id, p_step_key: stepSpecSchema.shape.key.parse(key),
      p_claim_token: uuid.parse(token), p_lease_seconds: lease.parse(leaseSeconds),
    }, value => z.boolean().parse(value));
  }

  async complete(scope: RunScope, runId: string, key: string, token: string, resultRef: string): Promise<void> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    await callRpc("supervisor_run_complete_step", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id,
      p_step_key: stepSpecSchema.shape.key.parse(key),
      p_claim_token: uuid.parse(token), p_result_ref: shortRef.parse(resultRef),
    }, value => z.object({ status: z.literal("completed") }).parse(value));
  }

  async reconcile(scope: RunScope, runId: string, key: string, verifiedResultRef: string): Promise<void> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    await callRpc("supervisor_run_reconcile", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id,
      p_step_key: stepSpecSchema.shape.key.parse(key),
      p_verified_result_ref: shortRef.parse(verifiedResultRef),
    }, value => z.object({ status: z.literal("completed") }).parse(value));
  }

  finish(scope: RunScope, runId: string, finalReportRef: string): Promise<DurableRun> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    return callRpc("supervisor_run_finish", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id, p_final_report_ref: shortRef.parse(finalReportRef),
    }, value => {
      const r = decodeRun(value);
      if (r.id !== id || r.businessId !== s.businessId ||
        r.ownerUserId !== s.ownerUserId || r.threadId !== s.threadId ||
        r.status !== "completed" || r.finalReportRef !== finalReportRef)
        throw new Error("Supervisor report outside owner scope");
      return r;
    });
  }
}

/** Existing SQL scheduler reserves one fair dispatch opportunity. Its
 * bounded reservation is independent of the scoped execution lease. */
export async function selectNextDurableRun(): Promise<{ runId: string; recovery: boolean } | null> {
  return callRpc("supervisor_select_next_durable_run", {}, value => {
    const candidate = z.object({ run_id: uuid, recovery: z.boolean() }).nullable().parse(value);
    return candidate ? { runId: candidate.run_id, recovery: candidate.recovery } : null;
  });
}

/** Fixed plan is server-owned; no caller can supply arbitrary effects. */
export async function admitOwnerRun(scope:RunScope,messageId:string,input:OwnerRunInput,steps:readonly StepSpec[]):Promise<DurableRun>{
  const s=runScopeSchema.parse(scope),key=uuid.parse(messageId),selected=ownerRunInputSchema.parse(input);
  const planHash=createHash("sha256").update(JSON.stringify(z.array(stepSpecSchema).parse(steps))).digest("hex");
  const result=await callRpc("supervisor_admit_owner_run_v2",{
    p_business_id:s.businessId,p_owner_user_id:s.ownerUserId,p_thread_id:s.threadId,
    p_owner_message_id:key,p_plan_hash:planHash,p_locale:selected.locale,p_attachment_ids:selected.attachmentIds,
  },decodeRun);
  if(result.businessId!==s.businessId||result.ownerUserId!==s.ownerUserId||result.threadId!==s.threadId||result.requestKey!==key)
    throw new Error("Supervisor run outside owner scope");
  return result;
}

type ToolResult=import("@/lib/ai/agent/tools").AgentToolResult;
const proposalSources:Record<string,string>={
  propose_price_change:"price_change_proposal",propose_price_experiment:"price_experiment_proposal",
  propose_staff_change:"staff_proposal",propose_add_staff:"staff_proposal",propose_schedule:"staff_proposal",
  propose_shift_change:"staff_proposal",propose_availability_change:"staff_proposal",
  propose_goal:"goal_proposal",propose_event_plan:"event_plan_proposal",
  propose_supplier_purchase_order:"supplier_purchase_proposal",propose_purchase_receiving:"supplier_purchase_proposal",
  propose_invoice_reconciliation:"supplier_purchase_proposal",propose_financial_settlement:"supplier_purchase_proposal",
  propose_financial_bill:"supplier_purchase_proposal",propose_gmail_action:"gmail_proposal",
  propose_supplier_discrepancy_followup:"gmail_proposal",
};
function stableJson(value:unknown):string{
  if(value===null||typeof value==="string"||typeof value==="number"||typeof value==="boolean")return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(stableJson).join(",")+"]";
  if(value&&typeof value==="object"){
    const obj=value as Record<string,unknown>;
    return "{"+Object.keys(obj).sort().map(k=>JSON.stringify(k)+":"+stableJson(obj[k])).join(",")+"}";
  }
  throw new Error("invalid_checkpoint_operation");
}
function operationKey(runId:string,name:string,raw:unknown):string{
  const hex=createHash("sha256").update(runId+"\\0"+name+"\\0"+stableJson(raw)).digest("hex");
  return hex.slice(0,8)+"-"+hex.slice(8,12)+"-4"+hex.slice(13,16)+"-8"+hex.slice(17,20)+"-"+hex.slice(20,32);
}

/** v2 operation journal: stores only scoped receipt IDs and hashes. Never
 * persist model reasoning, provider output, tool arguments or private source
 * documents here. On a restart source reads are refreshed via canonical tools.
 * An unclassified effect is not replayed as if it were a read. */
export async function openOwnerRunCheckpoint(scope:RunScope,runId:string,token:string,jobId:string):Promise<OwnerRunCheckpoint>{
  const {scope:s,runId:id}=parseIdentity(scope,runId);
  const identity={p_business_id:s.businessId,p_owner_user_id:s.ownerUserId,p_thread_id:s.threadId,
    p_run_id:id,p_claim_token:uuid.parse(token)};
  const db=createAdminSupabaseClient();
  const row=await db.from("supervisor_run_steps").select("checkpoint_seq,checkpoint_phase,checkpoint_operation,checkpoint_tool,checkpoint_receipts")
    .eq("business_id",s.businessId).eq("run_id",id).eq("step_key","owner_turn").single();
  if(row.error)throw new Error("checkpoint_storage_unavailable");
  let current:CheckpointRow=checkpointRowSchema.parse(row.data);
  const assertLive=async()=>{
    const fence=await db.rpc("supervisor_owner_job_fence_v2",identity);
    if(fence.error||fence.data!==true)throw new Error("durable_job_lease_lost");
    const heartbeat=await db.rpc("supervisor_update_owner_job_v2",{...identity,p_job_id:jobId,
      p_action:"heartbeat",p_step:null,p_reply_id:null,p_error_code:null});
    if(heartbeat.error||heartbeat.data!==true)throw new Error("durable_job_lease_lost");
  };
  const change=async(op:string,action:string,tool:string|null,receipt:string|null)=>{
    current=await callRpc("supervisor_checkpoint_owner_run_v2",{...identity,p_expected_seq:current.checkpoint_seq,
      p_operation:op,p_action:action,p_tool:tool,p_receipt_ref:receipt},v=>checkpointRowSchema.parse(v));
  };
  const finish=async(receipt:string)=>{
    if(!current.checkpoint_operation)throw new Error("checkpoint_operation_missing");
    await change(current.checkpoint_operation,"complete",null,receipt);
  };
  const scopedProposal=async(ref:string)=>{
    const result=await db.from("supervisor_proposals").select("id,status,revision,capability_id")
      .eq("business_id",s.businessId).eq("owner_user_id",s.ownerUserId).eq("thread_id",s.threadId)
      .eq("id",uuid.parse(ref)).maybeSingle();
    if(result.error||!result.data)throw new Error("checkpoint_receipt_unavailable");
    return result.data;
  };
  const recoverEffect=async(name:string,ref:string):Promise<ToolResult>=>{
    const [kind,value]=ref.split(":");
    if(kind==="proposal"&&proposalSources[name]){
      const p=await scopedProposal(value);
      return {source:proposalSources[name],period:null,missing:p.status==="draft"?[]:["prior_operation_already_recorded"],
        draft:p.status==="draft",saved:false,proposalId:p.id,revision:p.revision,proposalStatus:p.status,
        capabilityId:p.capability_id};
    }
    if(kind==="routine"&&name==="manage_routine"){
      const r=await db.from("supervisor_routines").select("id,status,revision")
        .eq("business_id",s.businessId).eq("owner_user_id",s.ownerUserId).eq("thread_id",s.threadId)
        .eq("id",uuid.parse(value)).maybeSingle();
      if(r.error||!r.data)throw new Error("checkpoint_receipt_unavailable");
      return {source:"supervisor_routines",period:null,missing:[],routine:r.data};
    }
    if(kind==="commitment"&&name==="manage_commitment"){
      const t=await db.from("operating_tasks").select("id,status,payload,due_local_date")
        .eq("business_id",s.businessId).eq("owner_user_id",s.ownerUserId).eq("id",value)
        .eq("kind","commitment").maybeSingle();
      if(t.error||!t.data||t.data.payload?.threadId!==s.threadId)throw new Error("checkpoint_receipt_unavailable");
      return {source:"operating_tasks",period:null,missing:[],commitmentId:t.data.id,commitmentStatus:t.data.status};
    }
    throw new Error("checkpoint_effect_receipt_unclassified");
  };
  await assertLive();
  // A provider/read interrupted before ACK can be safely abandoned, but its
  // reservation/unknown usage is never refunded and is not a verified result.
  if(current.checkpoint_phase==="effect_pending")throw new Error("checkpoint_effect_uncertain");
  if(current.checkpoint_phase!=="ready")
    await finish("abandoned:"+current.checkpoint_operation);
  const priorEffects=current.checkpoint_receipts.filter(x=>x.phase==="effect_pending");
  let replayed=false;
  return {
    assertLive,
    beginProvider:async()=>{
      await assertLive();
      await change(randomUUID(),"begin_provider",null,null);
    },
    endProvider:async(completed)=>{
      await assertLive();
      await finish((completed?"provider:":"abandoned:")+current.checkpoint_operation);
    },
    beginTool:async(name,raw,repeatSafe)=>{
      await assertLive();
      replayed=false;
      const op=repeatSafe?randomUUID():operationKey(id,name,raw);
      const previous=current.checkpoint_receipts.find(x=>x.operation===op);
      if(previous){
        if(previous.phase!=="effect_pending"||previous.tool!==name)throw new Error("checkpoint_operation_conflict");
        const result=await recoverEffect(name,previous.receipt);
        replayed=true;return result;
      }
      // On a replacement process do not treat altered arguments for the same
      // previously executed writer as a new authorization. The existing
      // canonical receipt remains available; require a fresh owner turn if
      // the model can't establish an exact matching operation.
      if(!repeatSafe&&priorEffects.some(e=>e.tool===name))throw new Error("checkpoint_effect_requires_reconciliation");
      await change(op,repeatSafe?"begin_read":"begin_effect",name,null);
      return null;
    },
    endTool:async(result)=>{
      await assertLive();
      if(replayed){replayed=false;return;}
      if(current.checkpoint_phase==="read_pending"){
        await finish("read:"+createHash("sha256").update(stableJson(result)).digest("hex"));return;
      }
      if(current.checkpoint_phase!=="effect_pending")throw new Error("checkpoint_operation_conflict");
      const name=current.checkpoint_tool??"";
      let ref:string|null=null;
      if(typeof result.proposalId==="string"&&uuid.safeParse(result.proposalId).success&&proposalSources[name]){
        await scopedProposal(result.proposalId);ref="proposal:"+result.proposalId;
      }else if(name==="manage_routine"&&result.routine&&typeof result.routine==="object"){
        const key=(result.routine as {id?:unknown}).id;if(typeof key==="string")ref="routine:"+key;
      }else if(name==="manage_commitment"){
        const key=result.commitmentId??(result.commitment as {id?:unknown}|undefined)?.id;
        if(typeof key==="string")ref="commitment:"+key;
      }
      if(!ref)throw new Error("checkpoint_effect_receipt_unclassified");
      await recoverEffect(name,ref);await finish(ref);
    },
    resumeContext:async()=>{
      if(!current.checkpoint_receipts.length)return null;
      const receipts=await Promise.all(priorEffects.map(async e=>({tool:e.tool,verified:await recoverEffect(e.tool??"",e.receipt)})));
      const reads=[...new Set(current.checkpoint_receipts.filter(e=>e.phase==="read_pending"&&e.receipt.startsWith("read:")).map(e=>e.tool))];
      return "Verified server-owned continuation receipts for this same assignment (not new owner authority). "+
        "Do not re-create recorded operations; re-read current business evidence if needed. "+
        JSON.stringify({completedOperations:receipts,previousReads:reads});
    },
    canYield:()=>current.checkpoint_phase!=="effect_pending",
    yieldForRetry:seconds=>callRpc("supervisor_yield_owner_run_v2",{...identity,p_expected_seq:current.checkpoint_seq,p_delay_seconds:seconds},v=>z.boolean().parse(v)),
  };
}
