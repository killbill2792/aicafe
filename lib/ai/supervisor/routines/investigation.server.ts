import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {createOwnerScopedCafeTools,readSupervisorCafeIdentity} from "@/lib/ai/cafeTools.server";
import {runAgentTurn} from "@/lib/ai/agent/loop.server";
import {withWorkerBudget} from "@/lib/ai/supervisor/runs/usage.server";
import {notifyOwner} from "@/lib/operating/notifyOwner.server";
import {readActionablePriorities} from "./dispatch.server";
import {investigationPrompt,investigationReadTools,verifyInvestigationTurn,
  type InvestigationCheckpoint,type SourceSynopsis} from "./investigation";

type Claimed={
  business_id:string;owner_user_id:string;thread_id:string;
  source_type:"alert"|"operating_task";source_id:string;revision_hash:string;
  stable_key:string;phase:"collect"|"investigate"|"awaiting_owner";
  step_version:number;lease_token:string;evidence:unknown;
  narrative?:string|null;last_error?:string|null;
};
export type InvestigationTick={
  processed:number;collected:number;investigated:number;followUps:number;
  rechecked:number;failed:number;
};
const empty=():InvestigationTick=>({processed:0,collected:0,investigated:0,followUps:0,rechecked:0,failed:0});
const stringField=(v:unknown,max=80)=>typeof v==="string"?v.slice(0,max):"unknown";
const object=(v:unknown):Record<string,unknown>|null=>
  v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const isOpen=(c:Claimed,status:string)=>c.source_type==="alert"?
  status==="new"||status==="seen":status==="needs_owner"||status==="needs_response";

/** Small source-shaped summaries, never source text as owner instructions.
 * Model tool calls read canonical café facts through the shared Supervisor path. */
async function collectSource(db:SupabaseClient,c:Claimed):Promise<SourceSynopsis>{
  // Keep literal schema select projections: dynamic strings defeat generated
  // Supabase types and can conceal a missing column at compile time.
  const {data,error}=c.source_type==="alert"?
    await db.from("alerts").select("kind,status,payload")
      .eq("business_id",c.business_id).eq("id",c.source_id).maybeSingle():
    await db.from("operating_tasks").select("kind,status,owner_user_id,confidence,evidence")
      .eq("business_id",c.business_id).eq("id",c.source_id).maybeSingle();
  if(error||!data)throw new Error("source_unavailable");
  const row=data as Record<string,unknown>;
  if(!isOpen(c,String(row.status)))throw new Error("source_unavailable");
  if(c.source_type==="operating_task"&&row.owner_user_id&&row.owner_user_id!==c.owner_user_id)
    throw new Error("authorization_revoked");
  const payload=object(c.source_type==="alert"?row.payload:
    Array.isArray(row.evidence)?row.evidence[0]:row.evidence);
  const facts=object(payload?.facts);
  const quality=payload?.quality??facts?.quality??row.confidence;
  const severity=payload?.severity??facts?.severity;
  const [alerts,tasks]=await Promise.all([
    db.from("alerts").select("kind,status").eq("business_id",c.business_id)
      .in("status",["new","seen"]).order("created_at",{ascending:false}).limit(8),
    db.from("operating_tasks").select("kind,status,owner_user_id")
      .eq("business_id",c.business_id).in("status",["needs_owner","needs_response"])
      .or("owner_user_id.is.null,owner_user_id.eq."+c.owner_user_id)
      .order("created_at",{ascending:false}).limit(8),
  ]);
  if(alerts.error||tasks.error)throw new Error("source_unavailable");
  const relatedTasks=(tasks.data??[]).filter(row=>!row.owner_user_id||
    row.owner_user_id===c.owner_user_id);
  return {
    kind:stringField(row.kind),status:stringField(row.status,24),
    severity:typeof severity==="string"?severity.slice(0,24):null,
    quality:typeof quality==="string"?quality.slice(0,24):null,
    relatedAlerts:(alerts.data??[]).map(row=>stringField(row.kind,60)),
    relatedTasks:relatedTasks.map(row=>stringField(row.kind,60)),
  };
}
async function finish(db:SupabaseClient,c:Claimed,now:Date,
  outcome:"collected"|"investigated"|"followed_up"|"rechecked",
  checkpoint:InvestigationCheckpoint,narrative:string|null):Promise<boolean>{
  const {data,error}=await db.rpc("supervisor_finish_investigation",{
    p_business_id:c.business_id,p_owner_user_id:c.owner_user_id,
    p_thread_id:c.thread_id,p_source_type:c.source_type,p_source_id:c.source_id,
    p_revision_hash:c.revision_hash,p_lease_token:c.lease_token,p_outcome:outcome,
    p_evidence:checkpoint,p_narrative:narrative,p_now:now.toISOString(),
  });
  if(error)throw new Error("storage_failed");
  return data===true;
}
function errorCode(error:unknown):string{
  const message=error instanceof Error?error.message:"";
  return ["source_unavailable","provider_unavailable","model_incomplete",
    "evidence_incomplete","authorization_revoked","time_exceeded",
    "storage_failed"].includes(message)?message:"storage_failed";
}
/** Recoverable failed read/model calls never close the incident or repeat an
 * effect. A DB-fenced failure maintains backoff and a visible last_error. */
async function fail(db:SupabaseClient,c:Claimed,error:unknown,now:Date):Promise<void>{
  const {data, error:writeError}=await db.rpc("supervisor_fail_investigation",{
    p_business_id:c.business_id,p_owner_user_id:c.owner_user_id,
    p_source_type:c.source_type,p_source_id:c.source_id,
    p_lease_token:c.lease_token,p_error:errorCode(error),p_now:now.toISOString(),
  });
  if(writeError)throw new Error("investigation_failure_not_persisted");
  // A source closure/revocation may have legitimately invalidated our lease.
  if(data!==true)return;
}
function previousCheckpoint(c:Claimed):InvestigationCheckpoint|null{
  const e=object(c.evidence);
  if(!e||!object(e.source)||typeof e.collectedAt!=="string")return null;
  return e as unknown as InvestigationCheckpoint;
}
/** One bounded step from the SAME 15-minute cron. Each step is reentrant and
 * leased at the database. There is never a synthetic owner instruction, and
 * system-initiated model calls have ONLY registered read-only tools. */
export async function processNextInvestigation(db:SupabaseClient,now:Date):
  Promise<InvestigationTick>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid investigation clock");
  const {data,error}=await db.rpc("supervisor_claim_investigation",{p_now:now.toISOString()});
  if(error)throw new Error("investigation_queue_unavailable");
  if(!data)return empty();
  const c=data as Claimed;
  const result=empty();result.processed=1;
  try{
    if(!c.business_id||!c.owner_user_id||!c.thread_id||
      !c.lease_token||!c.source_id||!c.revision_hash||
      !["collect","investigate","awaiting_owner"].includes(c.phase))
      throw new Error("storage_failed");
    if(c.phase==="collect"){
      const synopsis=await collectSource(db,c);
      const checkpoint:InvestigationCheckpoint={source:synopsis,collectedAt:now.toISOString()};
      if(!await finish(db,c,new Date(),"collected",checkpoint,null))
        throw new Error("storage_failed");
      result.collected=1;return result;
    }
    // The current source is reread on each continuation. If the source was
    // closed or owner lost access, SQL's fenced finish will refuse a stale write.
    const synopsis=await collectSource(db,c);
    const checkpoint=previousCheckpoint(c);
    if(!checkpoint)throw new Error("evidence_incomplete");
    // Persist continued monitoring without pestering the owner with six-hour
    // copies of the same generic alert. A new source revision re-enqueues
    // immediately, and an unchanged issue receives a verified daily follow-up.
    const lastUpdate=Date.parse(checkpoint.lastOwnerUpdate??"");
    const unchanged=JSON.stringify(synopsis)===JSON.stringify(checkpoint.source);
    if(c.phase==="awaiting_owner"&&!c.last_error&&unchanged&&
      Number.isFinite(lastUpdate)&&now.getTime()-lastUpdate>=0&&
      now.getTime()-lastUpdate<24*60*60*1000){
      const silent:InvestigationCheckpoint={...checkpoint,unchangedChecks:
        (checkpoint.unchangedChecks??0)+1};
      if(!await finish(db,c,new Date(),"rechecked",silent,null))
        throw new Error("storage_failed");
      result.rechecked=1;return result;
    }
    if(!process.env.OPENAI_API_KEY)throw new Error("provider_unavailable");
    // The existing paid entitlement check is separate from the SQL owner
    // membership+thread guard (which is rechecked by the final SQL transaction).
    try{await assertCafeAiAccess(c.business_id);}
    catch{throw new Error("authorization_revoked");}
    const identity=await readSupervisorCafeIdentity(c.business_id,db);
    const scope={businessId:c.business_id,ownerUserId:c.owner_user_id};
    const context={
      tools:createOwnerScopedCafeTools(scope,db),locale:"en" as const,
      asOf:identity.asOf,timezone:identity.timezone,currency:identity.currency,
      canonicalData:async()=>({db,businessId:c.business_id}),
    };
    const turn=await withWorkerBudget({
      maxElapsedMs:55_000,maxModelCalls:4,maxToolCalls:7,
      maxInputTokens:24_000,maxOutputTokens:3200,
    },()=>runAgentTurn({
      ownerText:investigationPrompt(synopsis,c.phase==="awaiting_owner",
        c.narrative??null),
      context,toolNames:investigationReadTools,businessId:c.business_id,
      requestId:c.stable_key,
    }));
    const verified=verifyInvestigationTurn(turn);
    if(!verified.ok)throw new Error(verified.reason);
    // The agent's complete, number-checked reply is the only owner-visible
    // result. An incomplete response is NEVER recorded as investigation done.
    const next:InvestigationCheckpoint={
      source:synopsis,collectedAt:checkpoint.collectedAt,
      modelTools:verified.tools,missing:verified.missing,
      modelCalls:turn.usage.modelCalls,toolCalls:turn.usage.toolCalls,
      lastOwnerUpdate:new Date().toISOString(),unchangedChecks:0,
    };
    const outcome=c.phase==="investigate"?"investigated":"followed_up";
    const notice=await notifyOwner(db,{
      businessId:c.business_id,ownerUserId:c.owner_user_id,
      threadId:c.thread_id,kind:"priority_investigation",
      taskId:"investigation:"+c.stable_key+":"+(c.step_version+1),
      localDate:identity.asOf,important:true,
    },()=>finish(db,c,new Date(),outcome,next,verified.text));
    if(notice.decision!=="posted"||notice.result!==true)
      throw new Error("storage_failed");
    if(c.phase==="investigate")result.investigated=1;
    else result.followUps=1;
  }catch(e){
    await fail(db,c,e,new Date());
    result.failed=1;
  }
  return result;
}
export async function processDueInvestigations(db:SupabaseClient,now:Date,maxSteps=2):
  Promise<InvestigationTick>{
  if(!Number.isSafeInteger(maxSteps)||maxSteps<0||maxSteps>4)
    throw new Error("Invalid investigation budget");
  const sum=empty();
  for(let i=0;i<maxSteps;i++){
    const step=await processNextInvestigation(db,now);
    if(!step.processed)break;
    for(const key of ["processed","collected","investigated","followUps","rechecked","failed"] as const)
      sum[key]+=step[key];
  }
  return sum;
}

/** A verified owner scan on the existing refresh scheduler installs durable
 * work regardless of whether its initial notice was previously delivered.
 * Per-source scope and current owner access are rechecked by the SQL enqueue. */
export async function enqueueInvestigationsForOwner(db:SupabaseClient,
  scope:{businessId:string;ownerUserId:string;threadId:string;localDate:string},
  now:Date):Promise<number>{
  const pending=await readActionablePriorities(db,scope,now,
    {includeNotified:true,limit:25});
  let enqueued=0;
  for(const decision of pending){
    const {data,error}=await db.rpc("supervisor_enqueue_investigation",{
      p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
      p_thread_id:scope.threadId,p_source_type:decision.source.sourceType,
      p_source_id:decision.source.sourceId,
      p_revision_hash:decision.revisionHash,p_stable_key:decision.stableKey,
      p_priority:decision.priority,p_now:now.toISOString(),
    });
    if(error)throw new Error("investigation_enqueue_failed");
    if(data===true)enqueued++;
  }
  return enqueued;
}
