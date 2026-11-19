import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {createOwnerScopedCafeTools,readSupervisorCafeIdentity} from "@/lib/ai/cafeTools.server";
import {runAgentTurn,openAIProvider,type AgentProvider} from "@/lib/ai/agent/loop.server";
import {assertDurablePaidTurnAllowed} from "@/lib/ai/supervisor/runs/worker.server";
import {meteredInvestigationProvider} from "./investigationUsage.server";
import type {AgentToolResult} from "@/lib/ai/agent/tools";
import {withWorkerBudget} from "@/lib/ai/supervisor/runs/usage.server";
import {notifyOwner} from "@/lib/operating/notifyOwner.server";
import {readActionablePriorities} from "./dispatch.server";
import {readClaimedStaffCoordination} from "@/lib/staffCoordination/cases.server";
import {readSupplierReconciliation} from "@/lib/data/supplierReceiving.server";
import {prepareSupplierDiscrepancyFollowup} from "@/lib/ai/supervisor/loop/supplierReceiving.server";
import {readStaffMessagesForVerifiedOwner} from "@/lib/staffCommunication/channel.server";
import {getWeekSchedule as readScopedWeekSchedule} from "@/lib/data/staffSchedule.server";
import {alreadyNotifiedTaskKinds} from "./priority";
import {getConnectorAccount,allowsGmail} from "@/lib/connectors/registry.server";
import {maintenanceContext,pollMaintenanceVendorReplies} from "@/lib/ai/supervisor/loop/maintenance.server";
import {investigationPrompt,investigationReadTools,maintenanceInvestigationTools,verifyInvestigationTurn,
  unsupportedExternalEffectClaim,type InvestigationCheckpoint,type SourceSynopsis} from "./investigation";

type Claimed={
  business_id:string;owner_user_id:string;thread_id:string;
  source_type:"alert"|"operating_task";source_id:string;revision_hash:string;
  stable_key:string;episode_id:string;phase:"collect"|"investigate"|"awaiting_owner";
  step_version:number;lease_token:string;evidence:unknown;
  narrative?:string|null;last_error?:string|null;
};
/** Sanitized instrumentation for an explicitly owner-authorized paid test.
 * No source payloads, answer text, prompts, IDs, tokens or tool arguments. */
export type InvestigationModelProofSummary={
  endReason:string;textLength:number;unverifiedCount:number;
  externalEffectClaim:boolean;toolNames:string[];resultDomains:string[];
  verified:boolean;failureCode:string|null;
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
  status==="new"||status==="seen":status==="needs_owner"||status==="needs_response"||status==="watching";

/** Small source-shaped summaries, never source text as owner instructions.
 * Model tool calls read canonical café facts through the shared Supervisor path. */
async function collectSource(db:SupabaseClient,c:Claimed,now:Date):Promise<SourceSynopsis>{
  // Keep literal schema select projections: dynamic strings defeat generated
  // Supabase types and can conceal a missing column at compile time.
  const {data,error}=c.source_type==="alert"?
    await db.from("alerts").select("kind,status,payload")
      .eq("business_id",c.business_id).eq("id",c.source_id).maybeSingle():
    await db.from("operating_tasks").select("kind,status,owner_user_id,confidence,evidence,payload,entity_type,entity_id,due_at")
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
      .eq("business_id",c.business_id).in("status",["needs_owner","needs_response","watching"])
      // Generated notice/receipt rows are NOT fresh café evidence. Filter in
      // SQL before the top-eight cap so older real tasks are not crowded out.
      .not("kind","in","(priority_notice,commitment,event_plan,event_change,event_report)")
      .or("owner_user_id.is.null,owner_user_id.eq."+c.owner_user_id)
      .order("created_at",{ascending:false}).limit(8),
  ]);
  if(alerts.error||tasks.error)throw new Error("source_unavailable");
  const relatedTasks=(tasks.data??[]).filter(row=>
    !alreadyNotifiedTaskKinds.has(String(row.kind))&&
    (!row.owner_user_id||row.owner_user_id===c.owner_user_id));
  return {
    kind:stringField(row.kind),status:stringField(row.status,24),
    severity:typeof severity==="string"?severity.slice(0,24):null,
    quality:typeof quality==="string"?quality.slice(0,24):null,
    relatedAlerts:(alerts.data??[]).map(row=>stringField(row.kind,60)),
    relatedTasks:relatedTasks.map(row=>stringField(row.kind,60)),
    ...(row.kind==="maintenance_issue"?{maintenanceDueAt:typeof row.due_at==="string"?row.due_at:null,
      maintenanceOverdue:typeof row.due_at==="string"&&Date.parse(row.due_at)<=now.getTime()}:{}),
  };
}
/** Read the EXACT incident the database leased, never a model-selected ID.
 * Opaque external text is not forwarded; selectors are allowlisted. For
 * timecard alerts, corroborate the claimed selector with a second, tenant
 * scoped canonical timecard read before showing it to the model. */
async function readIncidentEvidence(db:SupabaseClient,c:Claimed):
  Promise<AgentToolResult>{
  const {data,error}=c.source_type==="alert"?
    await db.from("alerts").select("kind,status,payload")
      .eq("business_id",c.business_id).eq("id",c.source_id).maybeSingle():
    await db.from("operating_tasks")
      .select("kind,status,payload,entity_type,entity_id,owner_user_id,due_at")
      .eq("business_id",c.business_id).eq("id",c.source_id).maybeSingle();
  if(error||!data)throw new Error("source_unavailable");
  const row=data as Record<string,unknown>;
  if(!isOpen(c,String(row.status)))throw new Error("source_unavailable");
  if(c.source_type==="operating_task"&&row.owner_user_id&&
    row.owner_user_id!==c.owner_user_id)throw new Error("authorization_revoked");
  const raw=object(row.payload);
  const selected:Record<string,string|boolean|null>={};
  const textKeys=["timecardId","employeeId","date","categoryCode",
    "monthKey","ownerChoice","snoozeUntil","suggestedPriceSource",
    "equipmentLabel","maintenanceStage","reportedAt","severity"];
  const booleanKeys=["awaitingPriceApplication","priceAppliedToPos",
    "scheduleApplied","ownerApproved","coverageConfirmed","externalSent","repairVerified"];
  for(const key of textKeys){
    const value=raw?.[key];
    if(typeof value==="string"&&value.length<=128&&
      !/[\r\n<>]/u.test(value))selected[key]=value;
  }
  for(const key of booleanKeys)
    if(typeof raw?.[key]==="boolean")selected[key]=raw[key] as boolean;
  // This is a report from an authenticated café member, NOT a sensor reading.
  // Treat its free text as hostile tool data, never as instructions.
  if(row.kind==="maintenance_issue"&&typeof raw?.symptom==="string")
    selected.symptom=raw.symptom.slice(0,600).replace(/[<>]/gu,"");
  if(row.kind==="maintenance_issue")selected.dueAt=typeof row.due_at==="string"?row.due_at:null;
  if(typeof row.entity_type==="string"&&row.entity_type.length<=64)
    selected.entityType=row.entity_type;
  if(typeof row.entity_id==="string"&&row.entity_id.length<=128)
    selected.entityId=row.entity_id;
  const missing:string[]=[];
  let linkedTimecard:Record<string,unknown>|null=null;
  if(c.source_type==="alert"&&row.kind==="meal_break"){
    const timecardId=selected.timecardId;
    if(typeof timecardId!=="string"||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(timecardId)){
      missing.push("timecard_selector_unavailable");
    }else{
      const linked=await db.from("timecards")
        .select("id,employee_id,clock_in,clock_out,breaks")
        .eq("business_id",c.business_id).eq("id",timecardId).maybeSingle();
      if(linked.error)throw new Error("source_unavailable");
      if(!linked.data||linked.data.employee_id!==selected.employeeId){
        missing.push("timecard_not_verified");
      }else{
        linkedTimecard={id:linked.data.id,employeeId:linked.data.employee_id,
          clockIn:linked.data.clock_in,clockOut:linked.data.clock_out,
          breaks:Array.isArray(linked.data.breaks)?
            linked.data.breaks.slice(0,12).map(b=>{
              const value=object(b);
              return {start:typeof value?.start==="string"?value.start:null,
                end:typeof value?.end==="string"?value.end:null};
            }):[]};
      }
    }
  }
  let maintenanceHistory:Array<{id:string;kind:string;sourceKind:string;verifiedWorking:boolean;
    occurredAt:string;note:string|null}>|null=null;
  if(row.kind==="maintenance_issue"&&c.source_type==="operating_task"){
    const events=await db.from("maintenance_case_events")
      .select("id,kind,source_kind,working_confirmed,occurred_at,note")
      .eq("business_id",c.business_id).eq("task_id",c.source_id)
      .order("occurred_at",{ascending:false}).limit(12);
    if(events.error)throw new Error("source_unavailable");
    maintenanceHistory=(events.data??[]).map(e=>({
      id:e.id,kind:e.kind,sourceKind:e.source_kind,verifiedWorking:e.kind==="operational_verification"&&
        ["owner_operational_check","staff_operational_check"].includes(e.source_kind)&&e.working_confirmed===true,
      occurredAt:e.occurred_at,note:typeof e.note==="string"?e.note.slice(0,600):null,
    }));
    if(!maintenanceHistory.length)missing.push("maintenance_report_receipt_missing");
  }
  return {source:"investigation_source",period:null,agentId:"alex",
    sourceType:c.source_type,sourceId:c.source_id,
    incidentKind:stringField(row.kind),sourceStatus:stringField(row.status,24),
    selectors:selected,linkedTimecard,maintenanceHistory,
    missing};
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
  // The shared Responses provider uses a stable "provider_error" sentinel.
  // A provider rejection must not be logged as a database/storage failure.
  if(message==="provider_error"||message==="provider_timeout")
    return "provider_unavailable";
  return ["source_unavailable","provider_unavailable","owner_quota_reached","model_incomplete",
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
export async function processNextInvestigation(db:SupabaseClient,now:Date,
  provider?:AgentProvider,onModelProof?:(summary:InvestigationModelProofSummary)=>void):
  Promise<InvestigationTick>{
  if(!Number.isFinite(now.getTime()))throw new Error("Invalid investigation clock");
  const {data,error}=await db.rpc("supervisor_claim_investigation",{p_now:now.toISOString()});
  if(error)throw new Error("investigation_queue_unavailable");
  if(!data)return empty();
  const c=data as Claimed;
  const result=empty();result.processed=1;
  try{
    if(!c.business_id||!c.owner_user_id||!c.thread_id||
      !c.lease_token||!c.source_id||!c.revision_hash||!c.episode_id||
      !["collect","investigate","awaiting_owner"].includes(c.phase))
      throw new Error("storage_failed");
    if(c.phase==="collect"){
      const synopsis=await collectSource(db,c,now);
      const checkpoint:InvestigationCheckpoint={source:synopsis,collectedAt:now.toISOString()};
      if(!await finish(db,c,new Date(),"collected",checkpoint,null))
        throw new Error("storage_failed");
      result.collected=1;return result;
    }
    // The current source is reread on each continuation. If the source was
    // closed or owner lost access, SQL's fenced finish will refuse a stale write.
    const synopsis=await collectSource(db,c,now);
    const maintenanceScope={businessId:c.business_id,ownerUserId:c.owner_user_id,
      threadId:c.thread_id,locale:"en" as const,verifiedReadClient:db};
    const maintenanceLease={caseId:c.source_id,token:c.lease_token,revisionHash:c.revision_hash};
    const vendorPoll=synopsis.kind==="maintenance_issue"?
      await pollMaintenanceVendorReplies(db,maintenanceScope,maintenanceLease):{added:0,missing:[]};
    const checkpoint=previousCheckpoint(c);
    if(!checkpoint)throw new Error("evidence_incomplete");
    // Persist continued monitoring without pestering the owner with six-hour
    // copies of the same generic alert. A new source revision re-enqueues
    // immediately, and an unchanged issue receives a verified daily follow-up.
    const lastUpdate=Date.parse(checkpoint.lastOwnerUpdate??"");
    const earlier=checkpoint.source;
    const unchanged=synopsis.kind===earlier.kind&&synopsis.status===earlier.status&&
      synopsis.quality===earlier.quality&&synopsis.severity===earlier.severity&&
      synopsis.maintenanceDueAt===earlier.maintenanceDueAt&&synopsis.maintenanceOverdue===earlier.maintenanceOverdue&&
      synopsis.relatedAlerts.length===earlier.relatedAlerts.length&&
      synopsis.relatedTasks.length===earlier.relatedTasks.length&&
      synopsis.relatedAlerts.every((item,i)=>item===earlier.relatedAlerts[i])&&
      synopsis.relatedTasks.every((item,i)=>item===earlier.relatedTasks[i]);
    if(c.phase==="awaiting_owner"&&!c.last_error&&unchanged&&vendorPoll.added===0&&JSON.stringify(vendorPoll.missing)===JSON.stringify(checkpoint.maintenanceReadMissing??[])&&
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
    // Reuse the existing owner paid-turn gate (entitlement + UTC quota).
    // No fabricated owner message grants permission for scheduled execution.
    try{
      await assertDurablePaidTurnAllowed({
        businessId:c.business_id,ownerUserId:c.owner_user_id,threadId:c.thread_id,
      },db);
    }catch(e){
      const code=(e as {code?:unknown})?.code;
      if(code==="owner_usage_limit_reached")throw new Error("owner_quota_reached");
      if(code==="usage_unavailable")throw new Error("storage_failed");
      throw new Error("authorization_revoked");
    }
    const metered=meteredInvestigationProvider(db,{
      businessId:c.business_id,ownerUserId:c.owner_user_id,threadId:c.thread_id,
      sourceType:c.source_type,sourceId:c.source_id,leaseToken:c.lease_token,
    },provider??openAIProvider);
    const identity=await readSupervisorCafeIdentity(c.business_id,db);
    const scope={businessId:c.business_id,ownerUserId:c.owner_user_id};
    const maintenance=maintenanceContext(db,maintenanceScope,{lease:maintenanceLease});
    let mailbox:Awaited<ReturnType<typeof getConnectorAccount>>=null;
    const checkMailbox=async()=>{
      if(!mailbox)return;
      const live=await getConnectorAccount(scope);
      if(!live||!allowsGmail(live,"read")||live.id!==mailbox.id||live.generation!==mailbox.generation||
        live.provider_subject!==mailbox.provider_subject)throw Error("authorization_revoked");
    };
    const context={
      tools:createOwnerScopedCafeTools(scope,db),locale:"en" as const,
      asOf:identity.asOf,timezone:identity.timezone,currency:identity.currency,
      canonicalData:async()=>({db,businessId:c.business_id}),
      ...(synopsis.kind==="maintenance_issue"?{maintenance:{...maintenance,search:async(...args:Parameters<typeof maintenance.search>)=>{
        await checkMailbox();
        mailbox=await getConnectorAccount(scope);
        if(!mailbox||!allowsGmail(mailbox,"read"))throw Error("authorization_revoked");
        const found=await maintenance.search(...args);await checkMailbox();return found;
      }}}:{}),
      ...(synopsis.kind==="supplier_receiving"?{receivingRead:async(purchaseOrderId:string)=>{
        // Never let an unattended model use a different PO from its SQL claim.
        const source=await readIncidentEvidence(db,c);
        const selectors=object(source.selectors);
        if(source.incidentKind!=="supplier_receiving"||source.missing.length||
          selectors?.entityType!=="purchase_order"||selectors.entityId!==purchaseOrderId)
          return {missing:["receiving_claim_scope_mismatch"],reconciliation:null};
        return readSupplierReconciliation(db,c.business_id,c.owner_user_id,purchaseOrderId);
      },receivingFollowup:async(purchaseOrderId:string)=>{
        const source=await readIncidentEvidence(db,c);
        const selectors=object(source.selectors);
        if(source.incidentKind!=="supplier_receiving"||source.missing.length||
          selectors?.entityType!=="purchase_order"||selectors.entityId!==purchaseOrderId)
          throw new Error("receiving_claim_scope_mismatch");
        return prepareSupplierDiscrepancyFollowup({...scope,threadId:c.thread_id,locale:"en",verifiedReadClient:db},purchaseOrderId);
      }}:{}),
      staffCoordinationRead:()=>readClaimedStaffCoordination(db,scope),
      staffMessages:{read:()=>readStaffMessagesForVerifiedOwner(
        db,c.business_id,c.owner_user_id,40)},
      investigation:{
        read:async()=>{const result=await readIncidentEvidence(db,c);return {...result,vendorReadMissing:vendorPoll.missing};},
        weekSchedule:(weekStart:string)=>readScopedWeekSchedule({weekStart},
          {client:db,businessId:c.business_id,ownerUserId:c.owner_user_id}),
      },
    };
    // Unprompted investigation needs room for its mandatory incident read,
    // two independent corroborating domains, and a final no-tool owner
    // report. The previous 4-call/24k-input/3.2k-output cap hit "budget"
    // after three real provider calls, discarding otherwise grounded findings
    // before a durable owner update. Keep 55s, seven read-only tool
    // executions and the shared one-Supervisor loop; never authorize effects.
    const turn=await withWorkerBudget({
      maxElapsedMs:55_000,maxModelCalls:6,maxToolCalls:7,
      maxInputTokens:72_000,maxOutputTokens:4800,
    },()=>runAgentTurn({
      serviceOrigin:true,provider:metered.provider,ownerText:investigationPrompt(synopsis,c.phase==="awaiting_owner",
        synopsis.kind==="maintenance_issue"?null:c.narrative??null),
      beforeProviderRequest:checkMailbox,beforeAcceptResult:checkMailbox,
      context,toolNames:synopsis.kind==="maintenance_issue"?maintenanceInvestigationTools:synopsis.kind==="supplier_receiving"?
        [...investigationReadTools,"propose_supplier_discrepancy_followup"]:investigationReadTools,businessId:c.business_id,
      requestId:c.stable_key,
    }));
    if(metered.problem())throw new Error(metered.problem()!);
    const verified=verifyInvestigationTurn(turn,{
      sourceType:c.source_type,sourceId:c.source_id,kind:synopsis.kind,
    });
    // Callback exists only for the trusted, opt-in live acceptance runner.
    // A model's fabricated action claim or numeric value is never logged.
    try{onModelProof?.({
      endReason:turn.endReason,textLength:turn.text.trim().length,
      unverifiedCount:turn.unverified.length,
      externalEffectClaim:unsupportedExternalEffectClaim(turn.text),
      toolNames:(turn.toolInvocations??[]).map(item=>item.name).slice(0,12),
      resultDomains:turn.results.map(item=>item.source).slice(0,12),
      verified:verified.ok,failureCode:verified.ok?null:verified.reason,
    });}catch{/* Instrumentation cannot influence production results. */}
    if(!verified.ok)throw new Error(verified.reason);
    // Entitlement can change while a paid model call is running. Recheck
    // before submitting a verified owner-facing report; SQL independently
    // rechecks membership, ownership and the conversation thread.
    try{await assertCafeAiAccess(c.business_id);}
    catch{throw new Error("authorization_revoked");}
    // The agent's complete, number-checked reply is the only owner-visible
    // result. An incomplete response is NEVER recorded as investigation done.
    const next:InvestigationCheckpoint={
      source:synopsis,collectedAt:checkpoint.collectedAt,
      modelTools:verified.tools,missing:verified.missing,
      modelCalls:turn.usage.modelCalls,toolCalls:turn.usage.toolCalls,
      lastOwnerUpdate:new Date().toISOString(),unchangedChecks:0,
      ...(synopsis.kind==="maintenance_issue"?{maintenanceReadMissing:vendorPoll.missing}:{}),
    };
    // Only a model-observed, exact PO with complete reconciliation is eligible.
    // Re-read independently before recording a closure checkpoint; a changed
    // receipt, invoice or canonical effect remains open for a fresh episode.
    const followup=turn.toolInvocations?.find(x=>x.name==="propose_supplier_discrepancy_followup"&&x.result.proposalCreated===true);
    if(synopsis.kind==="supplier_receiving"&&typeof followup?.result.proposalId==="string")
      next.receivingFollowupProposalId=followup.result.proposalId;
    let closePoId:string|null=null;
    if(synopsis.kind==="supplier_receiving"&&c.source_type==="operating_task"){
      const source=await readIncidentEvidence(db,c);
      const selectors=object(source.selectors);
      const poId=selectors?.entityType==="purchase_order"&&typeof selectors.entityId==="string"
        ?selectors.entityId:null;
      const observed=turn.toolInvocations?.filter(call=>call.name==="inspect_purchase_reconciliation")
        .map(call=>object(call.result.reconciliation))
        .find(r=>r?.purchaseOrderId===poId&&r.closureEvidenceReady===true);
      if(poId&&observed){
        const fresh=await readSupplierReconciliation(db,c.business_id,c.owner_user_id,poId);
        const fact=fresh.reconciliation;
        if(!fresh.missing.length&&fact?.closureEvidenceReady&&fact.poRevision===observed.poRevision
          &&fact.receiptVersionCount===observed.receiptVersionCount
          &&fact.invoiceVersionCount===observed.invoiceVersionCount){
          next.receivingClosureEvidence={poRevision:fact.poRevision,receiptVersions:fact.receiptVersionCount,
            invoiceVersions:fact.invoiceVersionCount};
          closePoId=poId;
        }
      }
    }
    const outcome=c.phase==="investigate"?"investigated":"followed_up";
    const notice=await notifyOwner(db,{
      businessId:c.business_id,ownerUserId:c.owner_user_id,
      threadId:c.thread_id,kind:"priority_investigation",
      taskId:"investigation:"+c.stable_key+":"+c.episode_id+":"+(c.step_version+1),
      localDate:identity.asOf,important:true,
    },async()=>{await checkMailbox();return finish(db,c,new Date(),outcome,next,verified.text);});
    if(notice.decision!=="posted"||notice.result!==true)
      throw new Error("storage_failed");
    if(closePoId&&next.receivingClosureEvidence){
      const p=next.receivingClosureEvidence;
      // The existing source-task lifecycle settles work only after exact
      // approved-effect proofs; failed closure leaves the investigation open.
      await db.rpc("supervisor_verify_supplier_reconciliation_closure",{
        p_business_id:c.business_id,p_owner_user_id:c.owner_user_id,p_thread_id:c.thread_id,
        p_purchase_order_id:closePoId,p_episode_id:c.episode_id,p_step_version:c.step_version+1,
        p_po_revision:p.poRevision,p_receipt_versions:p.receiptVersions,p_invoice_versions:p.invoiceVersions,
      });
    }
    if(c.phase==="investigate")result.investigated=1;
    else result.followUps=1;
  }catch(e){
    await fail(db,c,e,new Date());
    result.failed=1;
  }
  return result;
}
export async function processDueInvestigations(db:SupabaseClient,now:Date,maxSteps=2,
  provider?:AgentProvider,onModelProof?:(summary:InvestigationModelProofSummary)=>void):
  Promise<InvestigationTick>{
  if(!Number.isSafeInteger(maxSteps)||maxSteps<0||maxSteps>4)
    throw new Error("Invalid investigation budget");
  const sum=empty();
  for(let i=0;i<maxSteps;i++){
    // A just-collected incident is due immediately on its first continuation.
    // Reuse the SAME cron but advance the claim clock to real elapsed time;
    // reusing the initial tick timestamp otherwise stalls every two-step
    // investigation until the next 15-minute cron invocation.
    const stepNow=i===0?now:new Date(Math.max(now.getTime()+i,Date.now()));
    const step=await processNextInvestigation(db,stepNow,provider,onModelProof);
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
    // Defense in depth if a future ranking adapter includes supplier drafts:
    // only real alerts and operating tasks have investigation SQL identities.
    if(decision.source.sourceType!=="alert"&&
      decision.source.sourceType!=="operating_task")continue;
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
