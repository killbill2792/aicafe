import {getWeekSchedule} from "@/lib/actions/schedule";
import {proposalRequestKey} from "@/lib/ai/supervisor/loop/requestKeys";
import { historyContent } from "@/lib/ai/agent/history";
import {allocateReceiptIndexes,purchaseBatchKeys} from "@/lib/ai/supervisor/loop/receiptAllocation";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {priceExperimentCapabilityId} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {menuPriceChangeCapabilityId} from "@/lib/ai/supervisor/loop/menuPriceChange.server";
import {staffCapabilityId} from "@/lib/ai/supervisor/loop/staffProposals.server";
import {purchaseCapabilityId} from "@/lib/ai/supervisor/loop/purchases.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { addOwnerMessageInput, threadIdInput, type ConversationMessage, type ConversationScope } from "@/lib/ai/conversations/contracts";
import { conversationError, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import {ToolError} from "@/lib/ai/agent/toolErrors";
import {readMenuPriceEvidence} from "@/lib/data/menuPriceEvidence.server";
import {readSupervisorEconomics} from "@/lib/data/supervisorEconomics.server";
import {todaySoFarForBusiness} from "@/lib/data/todayLive.server";
import {goalCapabilityId} from "@/lib/ai/supervisor/loop/goal.server";
import {listOwnerGoals,readGoalStatus,roundForUnit} from "@/lib/ai/supervisor/loop/goalReads.server";
import {recordGoalCheckin} from "@/lib/ai/supervisor/loop/goalCheckins.server";
import {readOwnerProposals} from "@/lib/ai/supervisor/loop/reads.server";
import {metricCatalog} from "@/lib/calc/metrics/catalog";
import { isSupervisorChatConfigured, getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import type { NumericEvidence } from "@/lib/ai/agent/checkNumbers";
import { runAgentTurn, type OwnerFollowUp } from "@/lib/ai/agent/loop.server";
import { persistAgentReply, recordAgentTurnUsage, AgentReplyTooLongError, AgentReplyStorageError, AgentEmptyReplyError } from "@/lib/ai/agent/persist.server";
import { labelSupervisorThread, assertOwnerAgentTurnAvailable } from "@/lib/ai/conversations/usage.server";
import { styleReport } from "@/lib/ai/agent/style";
import type { AgentToolContext } from "@/lib/ai/agent/tools";
import { isJobStepAgent, type AgentJob } from "@/lib/ai/agent/jobState";
import { scheduleTurnAudit } from "@/lib/admin/audit.server";
import { assertCafeAiAccess } from "@/lib/access/access.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type { AgentTurn, AgentAuditStep } from "@/lib/ai/agent/loop.server";
import {loadOwnerFacts} from "@/lib/ownerFacts/store.server";
import {readCafeLocation} from "@/lib/data/cafeLocation.server";
import {searchNearbyEvents} from "@/lib/events/nearbyEventsSearch.server";
import {searchWeb} from "@/lib/ai/agent/webSearch.server";
import {readSavedEventTimeline} from "@/lib/data/cafeEvents.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60s agent deadline + one possible continuation turn + persistence. Only matters
// with background jobs on (the turn keeps running via after() once the owner leaves).
// Vercel: Hobby caps at 60s, Pro/Enterprise allow this (Fluid compute default 300s).
export const maxDuration = 150;
type RouteContext = { params: Promise<{ threadId: string }> };
type Emit = (type: string, data: unknown) => void;
type Locale = "en" | "es" | "ar";
type JobsModule = typeof import("@/lib/ai/agent/jobs.server");

const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" };
const CONTINUATION_BUDGET_MS = 75_000; // start a continuation only if it can finish before maxDuration

/** Fan-out for one running turn. The SSE response is only a viewer: when the owner
 * disconnects, emits are dropped but the turn continues (no throwing enqueue). */
function createTurnSink() {
  const viewers = new Set<{ emit: Emit; close: () => void }>();
  let closed = false;
  return {
    emit: ((type, data) => { for (const v of viewers) { try { v.emit(type, data); } catch { viewers.delete(v); } } }) as Emit,
    attach(viewer: { emit: Emit; close: () => void }) { if (closed) viewer.close(); else viewers.add(viewer); return () => viewers.delete(viewer); },
    close() { closed = true; for (const v of viewers) { try { v.close(); } catch { /* already closed */ } } viewers.clear(); },
  };
}
function sseStream(run: (emit: Emit, close: () => void, onCancel: (fn: () => void) => void) => void | Promise<void>) {
  const encoder = new TextEncoder();
  let cancelHook: (() => void) | null = null;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit: Emit = (type, data) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n")); }
        catch { open = false; } // owner went away; never abort the turn because of it
      };
      const close = () => { if (!open) return; open = false; try { controller.close(); } catch { /* closed */ } };
      await run(emit, close, fn => { cancelHook = fn; });
    },
    cancel() { cancelHook?.(); },
  }), { headers: SSE_HEADERS });
}
function errorCode(error: unknown): string {
  return error instanceof ConversationApiError ? error.code :
    error instanceof AgentReplyTooLongError ? "reply_too_long" :
    error instanceof AgentReplyStorageError ? "reply_storage_failed" :
    "agent_turn_failed";
}

type TurnParams = {
  scope: ConversationScope; threadId: string; owner: ConversationMessage; ownerText: string; locale: Locale;
  service: Awaited<ReturnType<typeof authenticatedConversationContext>>["service"];
  emit: Emit; job: AgentJob | null; jobs: JobsModule | null;
  attachmentIds?:string[];
};
/** Read only IDs explicitly selected for this turn. An old thread file is never
 * silently inserted into a subsequent model turn, even within the same café. */
async function readOwnerImages(scope:ConversationScope,threadId:string,ids:readonly string[]){
 if(ids.length===0)return [];
 if(ids.length>3||new Set(ids).size!==ids.length)throw new ConversationApiError(422,"invalid_attachments");
 const db=await createServerSupabaseClient();
 const {data,error}=await db.from("ai_attachments")
  .select("id,object_path,media_type,bytes")
  .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
  .eq("thread_id",threadId).in("id",[...ids]);
 if(error||!data||data.length!==ids.length)throw new ConversationApiError(403,"attachments_not_available");
 const images:Array<{mimeType:string;base64:string}>=[];
 for(const id of ids){
  const row=data.find(a=>a.id===id);
  if(!row||!["image/jpeg","image/png","image/webp"].includes(row.media_type)||row.bytes<1||row.bytes>2097152)
    throw new ConversationApiError(422,"unsupported_image_attachment");
  const {data:blob,error:downloadError}=await db.storage.from("ai-chat-private").download(row.object_path);
  if(downloadError||!blob||blob.size!==row.bytes)throw new ConversationApiError(503,"attachment_unavailable");
  images.push({mimeType:row.media_type,base64:Buffer.from(await blob.arrayBuffer()).toString("base64")});
 }
 return images;
}
/** One owner turn: tools → loop → persist → usage. Emits done/error and never throws. */
async function runOneTurn(p: TurnParams): Promise<{ replyId: string; absorbedOwnerMessageIds: string[] } | { errorCode: string }> {
  const { scope, threadId: id, owner, emit, job, jobs } = p;
  let logged = false;
  const startedAt = Date.now();
  const auditSteps: AgentAuditStep[] = [];
  let completedTurn: AgentTurn | undefined;
  let steps: Promise<void> = Promise.resolve();
  try {
    const [tools, identity, page, memory, ownerFactRead] = await Promise.all([
      createAuthenticatedCafeTools(), readSupervisorCafeIdentity(scope.businessId), p.service.listMessages(id, 0),
      loadMemory(),
       loadOwnerFacts(scope.businessId)
         .then(facts => ({facts,failed:false}))
         .catch(() => {console.error('owner_facts_read_failed'); return {facts:[],failed:true};}),
    ]);
    const priorAssistant=page.items.filter(m=>m.role==="supervisor"&&m.id!==owner.id).slice(-8);
    const previousEvidence:NumericEvidence[]=priorAssistant.flatMap(m=>{
      const candidate=m.grounding?.agentMetadata;
      if(!candidate||typeof candidate!=="object"||!Object.hasOwn(candidate,"evidence"))return [];
      const entries=(candidate as {evidence?:unknown}).evidence;
      if(!Array.isArray(entries))return [];
      return entries.filter((x):x is NumericEvidence=>x&&typeof x==="object"&&
        typeof x.tool==="string"&&Array.isArray(x.values)).slice(0,8);
    });
    // Previous assistant prose is conversation context, never source evidence.
    // Retain only typed evidence from successful tool reads. Messages queued for a
    // running job (sent after this one) are excluded: they arrive as follow-ups.
    const ownerAt = Date.parse(owner.createdAt);
    const history = page.items.filter(m => m.id !== owner.id &&
      (m.role === "owner" || m.role === "supervisor") &&
      !(job && m.role === "owner" && Number.isFinite(ownerAt) && Date.parse(m.createdAt) > ownerAt)).slice(-8)
      .map(m => ({ role: m.role === "owner" ? "user" as const : "assistant" as const,
        content: historyContent(m) })).filter(m => m.content);
    const context: AgentToolContext = { tools, asOf: identity.asOf, locale: p.locale,timezone:identity.timezone,currency:identity.currency,
      canonicalData:async()=>({db:await createServerSupabaseClient(),businessId:scope.businessId}),
      menuPriceEvidence:items=>readMenuPriceEvidence(scope.businessId,items,identity.asOf),
      readEconomics:async()=>readSupervisorEconomics(await createServerSupabaseClient(),scope.businessId,identity.asOf),
      // Toast credentials are service-role only; the café comes from the authenticated scope.
      readTodaySoFar:()=>todaySoFarForBusiness(createAdminSupabaseClient(),scope.businessId),
      // Location comes from the café profile or the owner's saved answer, never from the model.
      cafeLocation:async()=>readCafeLocation(await createServerSupabaseClient(),scope.businessId,ownerFactRead.facts),
      searchNearbyEvents,
      webSearch:async(query,budget)=>{await assertCafeAiAccess(scope.businessId);return searchWeb(query,budget);},
      savedEvents:async(from,to)=>readSavedEventTimeline(await createServerSupabaseClient(),
        {businessId:scope.businessId,ownerUserId:scope.ownerUserId},from,to),
      readWeekSchedule:weekStart=>getWeekSchedule({weekStart}),
      ownerFacts:ownerFactRead.facts,
      threadId:id,ownerMessageId:owner.id,
      ...(memory ? { memory: memory.port } : {}),
      goals:{
        propose:async(input)=>{
          const key=proposalRequestKey(id,JSON.stringify({ownerMessageId:owner.id,goal:input}));
          const proposal=await proposeLoop({...scope,threadId:id,locale:p.locale},supervisorLoopRegistry,
            new SupabaseLoopRepository(),goalCapabilityId,input,key);
          return {proposalId:proposal.id,revision:proposal.revision,
            title:String((proposal.canonicalEffectPayload as {title:string}).title)};
        },
        recordCheckin:async(goalId,date,answer,note)=>{
          // Only a goal this owner owns, read with the owner's own session.
          const owner={businessId:scope.businessId,ownerUserId:scope.ownerUserId};
          const [goal]=await readOwnerProposals(await createServerSupabaseClient(),owner,{id:goalId,limit:1});
          if(!goal||goal.capability_id!==goalCapabilityId)return {missing:["goalNotFound"]};
          const saved=await recordGoalCheckin(createAdminSupabaseClient(),owner,goalId,{date,answer,note});
          return saved?{saved:true,checkin:saved}:{missing:["noOpenCheckin"]};
        },
        status:async(goalId)=>{
          const db=await createServerSupabaseClient();
          const owner={businessId:scope.businessId,ownerUserId:scope.ownerUserId};
          if(!goalId)return {goals:await listOwnerGoals(db,owner)};
          const read=await readGoalStatus(db,{...owner,locale:p.locale},goalId,identity.asOf);
          if(!read)return {missing:["goalNotFound"]};
          const primary=read.effect.metrics.find(m=>m.role==="primary")!;
          const r=read.outcome.evaluation.results[primary.id];
          return {goal:{id:read.proposal.id,title:read.effect.title,status:read.proposal.status,
              startsOn:read.window.start,endsOn:read.window.end},
            evaluation:{status:read.outcome.evaluation.status,recommendation:read.outcome.recommendation,asOf:read.outcome.asOf},
            summary:read.text,sampledDays:read.sampledDays,
            metricDetail:{id:primary.id,metricKey:primary.metricKey,source:"computed",
              params:primary.itemId?{itemId:primary.itemId}:{},unit:metricCatalog[primary.metricKey].unit,
              comparator:primary.comparator,targetKind:primary.targetKind,target:primary.target},
            metricEvaluation:r?{current:roundForUnit(read.effect,primary.id,r.current),
              baseline:roundForUnit(read.effect,primary.id,r.baseline),
              target:roundForUnit(read.effect,primary.id,r.target),coverage:r.coverage}:null};
        },
      },
      proposals:{proposePriceChange:async({productId,newPriceCents})=>{
        const stable=JSON.stringify({ownerMessageId:owner.id,productId,newPriceCents});
        // RFC 4122 UUIDv5: the thread UUID is the namespace.
        const requestKey=proposalRequestKey(id,stable);
        const proposal=await proposeLoop({...scope,threadId:id,locale:p.locale},
          supervisorLoopRegistry,new SupabaseLoopRepository(),menuPriceChangeCapabilityId,
          {productId,newPriceCents},requestKey);
        const effect=proposal.canonicalEffectPayload as {
          productName:string;oldPriceCents:number;newPriceCents:number};
        return {proposalId:proposal.id,revision:proposal.revision,
          productName:effect.productName,oldPriceCents:effect.oldPriceCents,
          newPriceCents:effect.newPriceCents};
      },
      proposePriceExperiment:async({productId,newPriceCents,increaseCents,days})=>{
        if(days!==7)throw new ToolError("not_supported","This experiment currently supports a seven-day trial.");
        const catalog=await tools.getMenuCatalog();
        const item=catalog.available?catalog.value.find(x=>x.id===productId&&x.active):null;
        if(!item)throw new ToolError("not_found");
        if(item.priceCents===null)throw new ToolError("validation","An open-price item has no confirmed starting price.");
        const increase=increaseCents??(newPriceCents===null?null:newPriceCents-item.priceCents);
        if(increase===null||increase<=0)throw new ToolError("validation","Enter a positive price increase.");
        const key=proposalRequestKey(id,JSON.stringify({ownerMessageId:owner.id,productId,increase,days}));
        const proposal=await proposeLoop({...scope,threadId:id,locale:p.locale},supervisorLoopRegistry,
          new SupabaseLoopRepository(),priceExperimentCapabilityId,{productId,increaseCents:increase},key);
        const effect=proposal.canonicalEffectPayload as {productName:string;oldPriceCents:number;newPriceCents:number};
        return {proposalId:proposal.id,revision:proposal.revision,productName:effect.productName,oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents};
      },
      proposePurchases:async(input)=>{
        const output:Array<{proposalId?:string;revision?:number;name:string;error?:string}>=[];
        // Stable request keys are scoped to the logical line, NOT the tool-call position.
        // Read the whole receipt so batches start after previously allocated indexes.
        const receiptRows=input.source==="receipt_chat"?await createAdminSupabaseClient()
          .from("supervisor_proposals")
          .select("request_key,canonical_effect_payload")
          .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
          .eq("thread_id",id).eq("capability_id",purchaseCapabilityId):null;
        if(receiptRows?.error)throw new Error("receipt_proposals_unavailable");
        const existing=(receiptRows?.data??[]).filter(row=>
          (row.canonical_effect_payload as {receiptGroupId?:string}|null)?.receiptGroupId===owner.id);
        const requestKeys=purchaseBatchKeys(id,owner.id,input.source,input.lines);
        const indexes=allocateReceiptIndexes(requestKeys,existing.map(row=>({
          requestKey:row.request_key,index:
            (row.canonical_effect_payload as {receiptLineIndex?:number}).receiptLineIndex
        })));
        for(const [index,line] of input.lines.entries()){
          try{
            const requestKey=requestKeys[index];
            const receiptLineIndex=input.source==="receipt_chat"?indexes[index]:null;
            const proposal=await proposeLoop({...scope,threadId:id,locale:p.locale},supervisorLoopRegistry,
              new SupabaseLoopRepository(),purchaseCapabilityId,{...line,source:input.source,
                receiptGroupId:input.source==="receipt_chat"?owner.id:null,
                receiptLineIndex,
                receiptVendor:input.source==="receipt_chat"?input.receiptVendor:null,
                receiptTotalCents:input.source==="receipt_chat"?input.receiptTotalCents:null},requestKey);
            output.push({proposalId:proposal.id,revision:proposal.revision,name:line.name});
          }catch{output.push({name:line.name,error:"needs_review"});}
        }
        return output;
      },
      proposeStaff:async({name,input})=>{
        const requestKey=proposalRequestKey(id,JSON.stringify({ownerMessageId:owner.id,name,input}));
        const proposal=await proposeLoop({...scope,threadId:id,locale:p.locale},
          supervisorLoopRegistry,new SupabaseLoopRepository(),staffCapabilityId(name),input,requestKey);
        return {proposalId:proposal.id,revision:proposal.revision,capabilityId:proposal.capabilityId};
      }} };
    const ownerImages=await readOwnerImages(scope,id,p.attachmentIds??[]);
    const result = await runAgentTurn({ ownerText: p.ownerText, ownerImages, history, context,businessId:scope.businessId,requestId:owner.id,
       onAuditStep: step => { if (auditSteps.length < 64) auditSteps.push(step); },
      previousEvidence, ownerFacts:ownerFactRead.facts, ownerFactsReadFailed:ownerFactRead.failed,
      onTool:(name,agentId)=>{
        emit("tool",{name,agentId});
        // Ordered, best-effort persistence so a reloaded page can show the same steps.
        if (job && jobs && isJobStepAgent(agentId)) steps = steps.then(() => jobs.recordAgentJobStep(job.id, { tool: name, agent: agentId }));
      },
      onDelta: delta => emit("delta", { text: delta }),
      onReset: discardChars => emit("reset", { discardChars }),
      ...(memory ? { memoryFacts: memory.facts, extraTools: [memory.tool] } : {}),
      ...(job && jobs ? {
        takeFollowUps: (max: number): Promise<OwnerFollowUp[]> => jobs.takeAgentJobInbox(job.id, max),
        onFollowUp: (count: number) => emit("followup", { count }),
      } : {}) });
    completedTurn = result;
    let reply: Awaited<ReturnType<typeof persistAgentReply>>;
    try {
      if (!result.text.trim()) throw new AgentEmptyReplyError();
      reply = await persistAgentReply(scope, owner, result);
    } finally {
      // Billable usage must be counted even for blank, oversized or failed writes.
      try { await recordAgentTurnUsage(scope, owner, result); }
      catch { console.error("agent_usage_write_failed"); } // no owner data logged
      const style = styleReport(result.text);
      console.info("agent_turn",{turn:"agent",endReason:result.endReason,status:result.status.status,
        modelCalls:result.usage.modelCalls,toolCalls:result.usage.toolCalls,
        tools:result.tools??[],latencyMs:result.usage.latencyMs,
        unverifiedCount:result.unverified.length,
        ...(job ? { followUps: result.absorbedOwnerMessageIds?.length ?? 0 } : {}),
        ...(style ? { sentences: style.sentences, styleTooLong: style.tooLong, styleFiller: style.filler } : {})});
      logged=true;
    }
    await steps;
    scheduleTurnAudit({ scope, owner, startedAt, endedAt: Date.now(), replyId: reply.id,
      answer: result.text, turn: result, steps: auditSteps,
      status: result.endReason === "timeout" ? "timeout" :
        result.endReason === "provider_error" || result.endReason === "tool_errors" ? "failed" : "ok",
      ...(result.endReason === "complete" ? {} : { error: result.endReason }) });
    emit("done", { reply, status: result.status, endReason: result.endReason,
      unverified: result.unverified, usage: result.usage,
      ...(job ? { jobId: job.id, absorbedOwnerMessageIds: result.absorbedOwnerMessageIds ?? [] } : {}) });
    return { replyId: reply.id, absorbedOwnerMessageIds: result.absorbedOwnerMessageIds ?? [] };
  } catch (error) {
    if(!logged)console.info("agent_turn",{turn:"agent",endReason:"error",status:"unavailable",
      modelCalls:0,toolCalls:0,tools:[],latencyMs:Date.now()-startedAt,unverifiedCount:0});
    const code = errorCode(error);
    console.error("agent_sse_error",{code});
    scheduleTurnAudit({ scope, owner, startedAt, endedAt: Date.now(), turn: completedTurn,
      answer: completedTurn?.text, steps: auditSteps,
      status: completedTurn?.endReason === "timeout" ? "timeout" : "failed", error: code });
    emit("error", { code, ...(error instanceof AgentEmptyReplyError ? { retryable: true } : {}),
      ...(job ? { jobId: job.id } : {}) });
    return { errorCode: code };
  } finally { await steps.catch(() => undefined); }
}

/** café memory: approved café facts + the draft-only memory tool (RLS client). */
async function loadMemory() {
  const [{ authenticatedTeamRulesService }, { loadCafeMemory, cafeMemoryPort }, { memoryToolDefinition }] = await Promise.all([
    import("@/lib/ai/policies/auth.server"), import("@/lib/ai/agent/memory.server"), import("@/lib/ai/agent/tools/memory")]);
  try {
    const rules = await authenticatedTeamRulesService();
    return { facts: await loadCafeMemory(rules), port: cafeMemoryPort(rules), tool: memoryToolDefinition };
  } catch { console.error("agent_memory_unavailable"); return null; }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    if (!isSupervisorChatConfigured()) throw new ConversationApiError(503, "supervisor_not_enabled");
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    const { scope, service } = await authenticatedConversationContext();
    await assertCafeAiAccess(scope.businessId);
    const readiness = await getSupervisorChatReadiness(true);
    if (!readiness.enabled) throw new ConversationApiError(503, readiness.reason);
    const thread = await service.getThread(id);
    try { await assertOwnerAgentTurnAvailable(scope); }
    catch(error){ if(error instanceof ConversationApiError)console.error("agent_sse_error",{code:error.code}); throw error; }
    const owner = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    const prior = await getExistingSupervisorReply(scope, owner);
    if (thread.title === null) {
      try { await labelSupervisorThread(scope, id, input.text); } catch { /* title is optional */ }
    }
    const base = { scope, threadId: id, owner, ownerText: input.text, locale: input.locale, service,
      attachmentIds:input.attachmentIds??[] };

    if (prior) return sseStream((emit, close) => { emit("done", { reply: prior, replayed: true }); close(); });

    // Background jobs are always on; unavailable job storage falls back inline.
    const jobs = await import("@/lib/ai/agent/jobs.server");
    let started: Awaited<ReturnType<JobsModule["startAgentJob"]>>;
    try { started = await jobs.startAgentJob(scope, id, owner.id); }
    catch {
      // Jobs table unavailable: still answer, inline (never fail silently, never drop the turn).
      console.error("agent_job_start_failed");
      return sseStream(async (emit, close) => {
        try { await runOneTurn({ ...base, emit, job: null, jobs: null }); } finally { close(); }
      });
    }
    if (started.mode !== "started") {
      // attached: a turn is already running and will read this message before its next step.
      // running/done/absorbed: this message is already being (or was) answered. busy/failed: show retry.
      return sseStream((emit, close) => {
        emit("ack", { jobId: started.job.id, mode: started.mode });
        if (started.mode === "busy" || started.mode === "failed")
          emit("error", { code: started.mode === "busy" ? "agent_busy" : "attempts_exhausted", retryable: true, jobId: started.job.id });
        close();
      });
    }

    const sink = createTurnSink();
    const invokedAt = Date.now();
    const work = (async () => {
      let job: AgentJob | null = started.job, owner = base.owner, ownerText = base.ownerText;
      try {
        while (job) {
          const outcome = await runOneTurn({ ...base, owner, ownerText,
            attachmentIds:owner.id===base.owner.id?base.attachmentIds:[],emit: sink.emit, job, jobs });
          let next: AgentJob | null = null;
          try {
            next = (await jobs.finishAgentJob(job.id, "replyId" in outcome
              ? { status: "done", replyMessageId: outcome.replyId,
                ...(outcome.absorbedOwnerMessageIds.length ? { absorbedOwnerMessageIds: outcome.absorbedOwnerMessageIds } : {}) }
              : { status: "failed", errorCode: outcome.errorCode })).continuation;
          } catch { console.error("agent_job_finish_failed"); } // stale timeout will fail it in 180s
          job = null;
          if (!next) break;
          // Owner messages that arrived too late to be read get one continuation turn.
          if (Date.now() - invokedAt > CONTINUATION_BUDGET_MS) {
            await jobs.finishAgentJob(next.id, { status: "failed", errorCode: "timeout" }).catch(() => undefined);
            sink.emit("error", { code: "timeout", retryable: true, jobId: next.id });
            break;
          }
          try {
            await assertCafeAiAccess(scope.businessId);
            await assertOwnerAgentTurnAvailable(scope);
            owner = await jobs.readOwnerMessage(scope, id, next.ownerMessageId);
            ownerText = owner.text ?? "";
            job = next;
            sink.emit("ack", { jobId: next.id, mode: "continuation", ownerMessageId: next.ownerMessageId });
          } catch (error) {
            const code = errorCode(error);
            await jobs.finishAgentJob(next.id, { status: "failed", errorCode: code }).catch(() => undefined);
            sink.emit("error", { code, retryable: code !== "owner_usage_limit_reached", jobId: next.id });
          }
        }
      } finally { sink.close(); }
    })();
    jobs.keepTurnAlive(work);
    return sseStream((emit, close, onCancel) => {
      emit("ack", { jobId: started.job.id, mode: "started" });
      const detach = sink.attach({ emit, close });
      onCancel(() => { detach(); }); // owner left: stop streaming, keep working
    });
  } catch (error) { return conversationError(error); }
}
