import {createHash} from "node:crypto";
import "server-only";
import {cafeToday} from "@/lib/metrics/core/clock";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {notifyOwner} from "@/lib/operating/notifyOwner.server";
import {z} from "zod";
import {ACTIVE_PROPOSAL_STATUSES,ProposalRequestConflictError,effectHash} from "./engine";
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
/** UUID-shaped id from a stable key, so a repeated cron run cannot post twice. */
export function stableMessageId(key:string):string{
  const d=createHash("sha256").update(key).digest("hex");
  return d.slice(0,8)+"-"+d.slice(8,12)+"-4"+d.slice(13,16)+"-a"+d.slice(17,20)+"-"+d.slice(20,32);
}
/** The one mid-run update for an experiment: a short chat message in the
 * experiment's own thread. Never a task, never a second message. */
async function postMidRunUpdate(db:ReturnType<typeof createAdminSupabaseClient>,scope:OwnerLoopScope,
  p:LoopProposal,report:LoopReport,text:string):Promise<void>{
  if(text.length>1200)throw new Error("Invalid mid-run update text");
  // Also an inbox item, so the owner finds it in Operations. It is "watching"
  // (nothing to decide yet) and has its own id, so the final report still
  // creates its own needs-owner item.
  await notifyOwner(db,{
    businessId:scope.businessId,ownerUserId:scope.ownerUserId,threadId:scope.threadId,
    taskId:"supervisor:"+p.capabilityId+":"+p.id+":midrun"+
      (report.midRunKey?":"+report.midRunKey:""),
    kind:report.delivery?.taskKind??"supervisor_update",important:true,
  },async()=>{
  const delivery=report.delivery;
  if(delivery){
    const task=await db.from("operating_tasks").upsert({
      business_id:scope.businessId,id:"supervisor:"+p.capabilityId+":"+p.id+":midrun"+
        (report.midRunKey?":"+report.midRunKey:""),agent_id:delivery.agentId,
      kind:delivery.taskKind,entity_type:delivery.entityType,entity_id:delivery.entityId,status:"watching",
      confidence:"low",payload:{...delivery.payload,outcomeStatus:"in_progress",midRun:true,
        proposalId:p.id,threadId:p.threadId},evidence:delivery.evidence,
    },{onConflict:"business_id,id",ignoreDuplicates:true});
    if(task.error)failed(task.error,"Operations mid-run inbox unavailable");
  }
  const {data:business,error}=await db.from("businesses").select("timezone").eq("id",scope.businessId).single();
  if(error||!business?.timezone)throw new Error("Café timezone unavailable");
  const localDate=cafeToday(business.timezone);
  const inserted=await db.from("ai_messages").insert({
    id:stableMessageId("supervisor-midrun:"+p.id+(report.midRunKey?":"+report.midRunKey:"")),business_id:scope.businessId,thread_id:scope.threadId,
    owner_user_id:scope.ownerUserId,author_user_id:null,role:"supervisor",content_type:"blocks",
    text_content:null,structured_content:[{type:"text",text}],
    grounding:{status:"estimated",
      intent:p.capabilityId==="alex.event_readiness.v1"?"cafe_overview":"menu_pricing",
      evidence:[{source:p.capabilityId==="alex.event_readiness.v1"?"cafe_events":"operating_tasks",
      identifier:"supervisor-midrun:"+p.id,asOf:localDate}]},
  });
  if(inserted.error&&inserted.error.code!=="23505")failed(inserted.error,"Supervisor mid-run update unavailable");
  });
}
/** Narrative presentation is not new business evidence. JSONB key order must
 * not affect the comparison, and an actual change to any event fact still delivers. */
export function sameEventReportFacts(previous:unknown,next:unknown):boolean{
  if(!previous||!next||typeof previous!=="object"||typeof next!=="object"||
    Array.isArray(previous)||Array.isArray(next))return false;
  const old=previous as Record<string,unknown>;
  if(typeof old.reportText!=="string"||!old.reportText.trim())return false;
  const withoutPresentation=(raw:Record<string,unknown>)=>{
    const {reportText:ignoredText,reportFactsHash:ignoredHash,
      reportTextOrigin:ignoredOrigin,reportProvenance:ignoredProvenance,
      reportNumericEvidence:ignoredNumeric,...facts}=raw;
    void ignoredText;void ignoredHash;void ignoredOrigin;void ignoredProvenance;void ignoredNumeric;
    return facts;
  };
  return effectHash(withoutPresentation(old))===
    effectHash(withoutPresentation(next as Record<string,unknown>));
}
/** Service-role persistence. The API verifies the owner session BEFORE constructing
 * a scope; the database transition RPC locks revision/actor/effect hash atomically.
 * Authenticated callers can read only their own rows via RLS, never write them. */
export class SupabaseLoopRepository implements LoopRepository{
  async cafeTimezone(scope:OwnerLoopScope):Promise<string>{
    const db=createAdminSupabaseClient();
    const {data,error}=await db.from("businesses").select("timezone")
      .eq("id",scope.businessId).single();
    if(error||!data?.timezone)throw new Error("Café timezone unavailable");
    return data.timezone;
  }
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
      throw new ProposalRequestConflictError();
    return result;
  }
  async activeProposals(scope:OwnerLoopScope):Promise<LoopProposal[]>{
    const {data,error}=await createAdminSupabaseClient().from("supervisor_proposals").select("*")
      .eq("business_id",scope.businessId).in("status",[...ACTIVE_PROPOSAL_STATUSES])
      .order("created_at",{ascending:false}).limit(500);
    if(error)return failed(error,"Active proposals unavailable");
    return (data??[]).map(row=>decode(row as Row));
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
    action:"approve"|"reject"|"claim_commit"|"manual_pending"|"manual_confirmed"|"committed"|"finish_monitor",
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
  /** These two menu-only operations extend the existing ledger rather than
   * creating a second proposal store. Both SQL functions are service-only and
   * lock the scoped, revisioned proposal row. */
  /** Staff effects and committed ledger state are written in one SQL transaction. */
  async commitStaff(scope:OwnerLoopScope,id:string,revision:number):
    Promise<{state:"applied"|"stale";proposal:LoopProposal}>{
    const {data,error}=await createAdminSupabaseClient().rpc("supervisor_commit_staff_proposal",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_thread_id:scope.threadId,p_proposal_id:uuid.parse(id),p_revision:revision,
    });
    if(error||!data)failed(error,"Staff approval transaction failed");
    const result=data as {state:string;proposal:Row};
    if((result.state!=="applied"&&result.state!=="stale")||!result.proposal)
      throw new Error("Invalid staff commit result");
    const proposal=decode(result.proposal);
    if(proposal.businessId!==scope.businessId||proposal.ownerUserId!==scope.ownerUserId||
      proposal.threadId!==scope.threadId||proposal.id!==id||
      proposal.status!==(result.state==="applied"?"committed":"stale"))
      throw new Error("Staff commit result outside approval scope");
    return {state:result.state,proposal};
  }
  async editPurchaseDraft(scope:OwnerLoopScope,id:string,revision:number,effect:Record<string,unknown>,
    hash:string):Promise<LoopProposal>{
    const {data,error}=await createAdminSupabaseClient().rpc("supervisor_edit_inventory_purchase",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
      p_proposal_id:uuid.parse(id),p_revision:revision,p_effect:effect,p_effect_hash:hash
    });
    if(error||!data)return failed(error,"Purchase proposal edit conflict");
    const proposal=decode(data as Row);
    if(proposal.id!==id||proposal.businessId!==scope.businessId||
      proposal.ownerUserId!==scope.ownerUserId||proposal.threadId!==scope.threadId)
      throw new Error("Edited purchase outside scope");
    return proposal;
  }
  async markStalePrice(scope:OwnerLoopScope,id:string,revision:number):Promise<LoopProposal>{
    const db=createAdminSupabaseClient();
    const {data,error}=await db.rpc("supervisor_mark_stale_menu_price",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_thread_id:scope.threadId,p_proposal_id:uuid.parse(id),p_revision:revision,
    });
    if(error||!data)return failed(error,"Proposal stale transition failed");
    return decode(data as Row);
  }
  async replacePriceDraft(scope:OwnerLoopScope,id:string,revision:number,
    requestKey:string,newEffect:Record<string,unknown>,newEffectHash:string):
    Promise<{replaced:LoopProposal;proposal:LoopProposal}>{
    const db=createAdminSupabaseClient();
    const {data,error}=await db.rpc("supervisor_replace_menu_price_draft",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_thread_id:scope.threadId,p_proposal_id:uuid.parse(id),p_revision:revision,
      p_request_key:uuid.parse(requestKey),p_effect:newEffect,p_effect_hash:newEffectHash,
    });
    if(error||!data)return failed(error,"Proposal edit transaction failed");
    const rows=data as {replaced:Row;proposal:Row};
    const replaced=decode(rows.replaced),proposal=decode(rows.proposal);
    if(replaced.businessId!==scope.businessId||replaced.ownerUserId!==scope.ownerUserId||
      replaced.threadId!==scope.threadId||proposal.businessId!==scope.businessId||
      proposal.ownerUserId!==scope.ownerUserId||proposal.threadId!==scope.threadId)
      throw new Error("Proposal edit returned outside scope");
    return {replaced,proposal};
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
  async saveReport(scope:OwnerLoopScope,p:LoopProposal,report:LoopReport,opts?:{midRun?:boolean}):Promise<void>{
    const db=createAdminSupabaseClient();
    const persisted={...report.result,source:report.source,
      recommendation:report.recommendation};
    let formattingOnly=false;
    if(p.capabilityId==="alex.event_readiness.v1"&&report.status!=="in_progress"){
      const previous=await db.from("supervisor_reports").select("report,status")
        .eq("business_id",scope.businessId).eq("proposal_id",p.id).maybeSingle();
      if(previous.error)failed(previous.error,"Previous event report unavailable");
      formattingOnly=previous.data?.status===report.status&&
        sameEventReportFacts(previous.data.report,persisted);
    }
    const written=await db.from("supervisor_reports").upsert({
      business_id:scope.businessId,proposal_id:p.id,report:persisted,status:report.status,
      generated_at:new Date().toISOString(),
    },{onConflict:"business_id,proposal_id"});
    if(written.error)failed(written.error,"Report save failed");
    if(report.status==="in_progress"){
      if(opts?.midRun&&report.midRunText?.trim())await postMidRunUpdate(db,scope,p,report,report.midRunText);
      return;
    }
    // The platform is domain-neutral: delivery contracts originate only in
    // the registered capability's verified report, not in a price-specific
    // task writer or a generic second inbox.
    const delivery=report.delivery;
    if(!delivery)return;
    const taskId="supervisor:"+p.capabilityId+":"+p.id;
    let alreadyMessaged=false;
    if(formattingOnly){
      // A saved report is NOT proof of delivery: an earlier attempt may have
      // failed after the report upsert but before its inbox/chat writes.
      // Existing rows are the durable delivery receipts (including legacy
      // reports); do not add a second ledger or mark delivery prematurely.
      const [taskSent,messageSent]=await Promise.all([
        db.from("operating_tasks").select("id").eq("business_id",scope.businessId)
          .eq("id",taskId).maybeSingle(),
        db.from("ai_messages").select("id").eq("business_id",scope.businessId)
          .eq("owner_user_id",scope.ownerUserId).eq("thread_id",p.threadId)
          .eq("role","supervisor")
          .contains("grounding",{evidence:[{
            source:"operating_tasks",identifier:"supervisor-report:"+p.id,
          }]})
          .limit(1).maybeSingle(),
      ]);
      if(taskSent.error||messageSent.error)
        failed(taskSent.error??messageSent.error,"Supervisor report delivery lookup unavailable");
      // Both writes must have succeeded before a format-only refresh may
      // skip the existing canonical delivery path. A partial write retries.
      if(taskSent.data&&messageSent.data)return;
      // If only the inbox was lost, repair it without reposting an older
      // delivered chat message under a new narrative-format digest.
      alreadyMessaged=Boolean(messageSent.data);
    }
    await notifyOwner(db,{
      businessId:scope.businessId,ownerUserId:scope.ownerUserId,threadId:scope.threadId,
      taskId,kind:delivery.taskKind,important:true,
    },async()=>{
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
      confidence:delivery.confidence,payload:{...delivery.payload,proposalId:p.id,threadId:p.threadId},
      evidence:delivery.evidence,updated_at:new Date().toISOString(),
    }).eq("business_id",scope.businessId).eq("id",taskId);
    if(refreshed.error)failed(refreshed.error,"Operations report update failed");
    if(alreadyMessaged)return;
    if(!delivery.threadText.trim()||delivery.threadText.length>1200)
      throw new Error("Invalid canonical Supervisor report text");
    // Unique proposal UUID makes repeated cron runs idempotent; a late
    // duplicate cannot send repeated unsolicited owner messages.
    const {data:business,error:timezoneError}=await db.from("businesses")
      .select("timezone").eq("id",scope.businessId).single();
    if(timezoneError||!business?.timezone)throw new Error("Café timezone unavailable");
    const localDate=cafeToday(business.timezone);
    const ref={source:"operating_tasks",identifier:"supervisor-report:"+p.id,
      asOf:localDate};
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
    const verification=delivery.numberProvenance?{
      unverified:delivery.numberProvenance.map(span=>({...span,blockIndex:0})),
      evidence:delivery.numericEvidence??[],
    }:null;
    const inserted=await db.from("ai_messages").insert({
      id:messageId,business_id:scope.businessId,thread_id:scope.threadId,
      owner_user_id:scope.ownerUserId,author_user_id:null,
      role:"supervisor",content_type:"blocks",text_content:null,
      structured_content:[{type:"text",text:delivery.threadText}],
      grounding:{status:report.status==="insufficient_evidence"?
        "insufficient_evidence":"estimated",intent:"menu_pricing",evidence:[ref],
        ...(verification?{agentMetadata:verification}:{})},
    });
    if(inserted.error&&inserted.error.code!=="23505")
      failed(inserted.error,"Supervisor thread report unavailable");
    });
  }
}
