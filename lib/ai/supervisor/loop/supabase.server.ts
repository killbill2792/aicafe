import {createHash} from "node:crypto";
import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {z} from "zod";
import type {LoopCreate,LoopRepository,OwnerLoopScope,LoopProposal,LoopSample,LoopReport} from "./engine";

const uuid=z.uuid();
type Row={
 id:string;business_id:string;owner_user_id:string;thread_id:string;
 capability_id:string;capability_version:number;canonical_effect_payload:unknown;
 effect_hash:string;baseline:Record<string,unknown>;monitor_spec:{durationDays:number;metricScope:string};
 status:LoopProposal["status"];revision:number;locale:LoopProposal["locale"];
 monitoring_start_date:string|null;created_at:string;
};
const decode=(r:Row):LoopProposal=>({
  id:r.id,businessId:r.business_id,ownerUserId:r.owner_user_id,threadId:r.thread_id,
  capabilityId:r.capability_id,capabilityVersion:r.capability_version,
  canonicalEffectPayload:r.canonical_effect_payload,effectHash:r.effect_hash,
  baseline:r.baseline,monitorSpec:r.monitor_spec,status:r.status,revision:r.revision,
  locale:r.locale,monitoringStartDate:r.monitoring_start_date,createdAt:r.created_at,
});
const failed=(error:unknown,code:string):never=>{throw new Error(code,{cause:error});};
/** Service-role persistence. The API verifies the owner session BEFORE constructing
 * a scope; the database transition RPC locks revision/actor/effect hash atomically.
 * Authenticated callers can read only their own rows via RLS, never write them. */
export class SupabaseLoopRepository implements LoopRepository{
  async create(scope:OwnerLoopScope,key:string,p:LoopCreate):Promise<LoopProposal>{
    uuid.parse(key);
    const db=createAdminSupabaseClient();
    const inserted=await db.from("supervisor_proposals").insert({
      business_id:scope.businessId,owner_user_id:scope.ownerUserId,thread_id:scope.threadId,
      request_key:key,capability_id:p.capabilityId,capability_version:p.capabilityVersion,
      canonical_effect_payload:p.canonicalEffectPayload,effect_hash:p.effectHash,
      baseline:p.baseline,monitor_spec:p.monitorSpec,locale:scope.locale,
    }).select("*").single();
    if(!inserted.error&&inserted.data)return decode(inserted.data as Row);
    if(inserted.error?.code!=="23505")return failed(inserted.error,"Proposal write failed");
    // Identical retry keys are idempotent only for an identical, scoped payload.
    const previous=await db.from("supervisor_proposals").select("*")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",scope.threadId).eq("request_key",key).single();
    if(previous.error||!previous.data)return failed(previous.error,"Proposal retry unavailable");
    const result=decode(previous.data as Row);
    if(result.effectHash!==p.effectHash||result.capabilityId!==p.capabilityId)
      throw new Error("Conflicting proposal request key");
    return result;
  }
  async load(scope:OwnerLoopScope,id:string):Promise<LoopProposal>{
    uuid.parse(id);
    const db=createAdminSupabaseClient();
    const {data,error}=await db.from("supervisor_proposals").select("*")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",scope.threadId).eq("id",id).maybeSingle();
    if(error||!data)return failed(error,"Proposal not available");
    return decode(data as Row);
  }
  async transition(scope:OwnerLoopScope,id:string,revision:number,
    action:"approve"|"reject"|"claim_commit"|"manual_pending"|"manual_confirmed"|"committed",
    startDate?:string):Promise<LoopProposal>{
    const db=createAdminSupabaseClient();
    const {data,error}=await db.rpc("supervisor_transition_proposal",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_proposal_id:uuid.parse(id),p_revision:revision,p_action:action,
      p_monitoring_start_date:startDate??null,
    });
    if(error||!data)return failed(error,"Proposal state conflict");
    return decode(data as Row);
  }
  async addSample(scope:OwnerLoopScope,id:string,sample:LoopSample):Promise<void>{
    const db=createAdminSupabaseClient();
    const {error}=await db.from("supervisor_monitor_samples").upsert({
      business_id:scope.businessId,proposal_id:id,business_date:sample.businessDate,
      observation:sample.observation,evidence_source:sample.source,
    },{onConflict:"business_id,proposal_id,business_date"});
    if(error)failed(error,"Monitor sample write failed");
  }
  async clearSample(scope:OwnerLoopScope,id:string,businessDate:string):Promise<void>{
    const db=createAdminSupabaseClient();
    const {error}=await db.from("supervisor_monitor_samples").delete()
      .eq("business_id",scope.businessId).eq("proposal_id",id)
      .eq("business_date",businessDate);
    if(error)failed(error,"Monitor source withdrawal failed");
  }
  async samples(scope:OwnerLoopScope,id:string):Promise<LoopSample[]>{
    const db=createAdminSupabaseClient();
    const {data,error}=await db.from("supervisor_monitor_samples")
      .select("business_date,observation,evidence_source").eq("business_id",scope.businessId)
      .eq("proposal_id",id).order("business_date",{ascending:true});
    if(error)failed(error,"Monitor evidence unavailable");
    return (data??[]).map(row=>({businessDate:row.business_date,
      observation:row.observation as Record<string,unknown>,source:row.evidence_source}));
  }
  async saveReport(scope:OwnerLoopScope,p:LoopProposal,report:LoopReport):Promise<void>{
    const db=createAdminSupabaseClient();
    const written=await db.from("supervisor_reports").upsert({
      business_id:scope.businessId,proposal_id:p.id,report:{...report.result,source:report.source,
        recommendation:report.recommendation},status:report.status,
      generated_at:new Date().toISOString(),
    },{onConflict:"business_id,proposal_id"});
    if(written.error)failed(written.error,"Report save failed");
    if(report.status==="in_progress")return;
    // The platform is domain-neutral: delivery contracts originate only in
    // the registered capability's verified report, not in a price-specific
    // task writer or a generic second inbox.
    const delivery=report.delivery;
    if(!delivery)return;
    const taskId="supervisor:"+p.capabilityId+":"+p.id;
    const task=await db.from("operating_tasks").upsert({
      business_id:scope.businessId,id:taskId,agent_id:delivery.agentId,
      kind:delivery.taskKind,entity_type:delivery.entityType,entity_id:delivery.entityId,
      status:"needs_owner",confidence:delivery.confidence,
      payload:{...delivery.payload,proposalId:p.id,threadId:p.threadId},evidence:delivery.evidence,
    },{onConflict:"business_id,id",ignoreDuplicates:true});
    if(task.error)failed(task.error,"Operations report inbox unavailable");
    // Source evidence may arrive late; refresh measurements without reopening
    // an owner-handled task or overwriting its lifecycle status.
    const refreshed=await db.from("operating_tasks").update({
      confidence:delivery.confidence,payload:{...delivery.payload,proposalId:p.id},
      evidence:delivery.evidence,updated_at:new Date().toISOString(),
    }).eq("business_id",scope.businessId).eq("id",taskId);
    if(refreshed.error)failed(refreshed.error,"Operations report update failed");
    if(!delivery.threadText.trim()||delivery.threadText.length>1200)
      throw new Error("Invalid canonical Supervisor report text");
    // Unique proposal UUID makes repeated cron runs idempotent; a late
    // duplicate cannot send repeated unsolicited owner messages.
    const ref={source:"operating_tasks",identifier:"supervisor-report:"+p.id,
      asOf:new Date().toISOString().slice(0,10)};
    // Append a new, stable revision ONLY when the evidence-backed report
    // content changes after a corrected source sync. Same payload => same UUID
    // => duplicate insert safely ignored. Previously delivered messages stay
    // historically accurate rather than being silently edited.
    const digest=createHash("sha256").update(JSON.stringify({
      proposalId:p.id,status:report.status,result:report.result,
      recommendation:report.recommendation,threadText:delivery.threadText,
    })).digest("hex");
    const messageId=digest.slice(0,8)+"-"+digest.slice(8,12)+"-4"+
      digest.slice(13,16)+"-a"+digest.slice(17,20)+"-"+digest.slice(20,32);
    const inserted=await db.from("ai_messages").insert({
      id:messageId,business_id:scope.businessId,thread_id:scope.threadId,
      owner_user_id:scope.ownerUserId,author_user_id:null,
      role:"supervisor",content_type:"blocks",text_content:null,
      structured_content:[{type:"text",text:delivery.threadText}],
      grounding:{status:report.status==="insufficient_evidence"?
        "insufficient_evidence":"estimated",intent:"menu_pricing",evidence:[ref]},
    });
    if(inserted.error&&inserted.error.code!=="23505")
      failed(inserted.error,"Supervisor thread report unavailable");
  }
}
