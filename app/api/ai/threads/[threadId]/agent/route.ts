import {proposalRequestKey} from "@/lib/ai/supervisor/loop/requestKeys";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {menuPriceChangeCapabilityId} from "@/lib/ai/supervisor/loop/menuPriceChange.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { addOwnerMessageInput, threadIdInput, type ConversationMessage, type ConversationScope } from "@/lib/ai/conversations/contracts";
import { conversationError, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { isSupervisorChatConfigured, getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import type { NumericEvidence } from "@/lib/ai/agent/checkNumbers";
import { runAgentTurn, type OwnerFollowUp } from "@/lib/ai/agent/loop.server";
import { persistAgentReply, recordAgentTurnUsage, AgentReplyTooLongError, AgentReplyStorageError, AgentEmptyReplyError } from "@/lib/ai/agent/persist.server";
import { labelSupervisorThread, assertOwnerAgentTurnAvailable } from "@/lib/ai/conversations/usage.server";
import { chatExperienceFlags, type ChatExperienceFlags } from "@/lib/ai/agent/flags";
import { styleReport } from "@/lib/ai/agent/style";
import type { AgentToolContext } from "@/lib/ai/agent/tools";
import { isJobStepAgent, type AgentJob } from "@/lib/ai/agent/jobState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60s agent deadline + one possible continuation turn + persistence. Only matters
// with CHAT_JOBS on (the turn keeps running via after() once the owner leaves).
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
  flags: ChatExperienceFlags; emit: Emit; job: AgentJob | null; jobs: JobsModule | null;
};
/** One owner turn: tools → loop → persist → usage. Emits done/error and never throws. */
async function runOneTurn(p: TurnParams): Promise<{ replyId: string } | { errorCode: string }> {
  const { scope, threadId: id, owner, emit, flags, job, jobs } = p;
  let logged = false;
  const startedAt = Date.now();
  let steps: Promise<void> = Promise.resolve();
  try {
    const [tools, identity, page, memory] = await Promise.all([
      createAuthenticatedCafeTools(), readSupervisorCafeIdentity(scope.businessId), p.service.listMessages(id, 0),
      flags.memory ? loadMemory() : Promise.resolve(null),
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
        content: m.text ?? (m.blocks ?? []).flatMap(b => b && typeof b === "object" && "text" in b ?
          [String(b.text)] : []).join(" ") })).filter(m => m.content);
    const context: AgentToolContext = { tools, asOf: identity.asOf, locale: p.locale,timezone:identity.timezone,
      threadId:id,ownerMessageId:owner.id,
      ...(memory ? { memory: memory.port } : {}),
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
      }} };
    const result = await runAgentTurn({ ownerText: p.ownerText, history, context,
      previousEvidence,
      onTool:(name,agentId)=>{
        emit("tool",{name,agentId});
        // Ordered, best-effort persistence so a reloaded page can show the same steps.
        if (job && jobs && isJobStepAgent(agentId)) steps = steps.then(() => jobs.recordAgentJobStep(job.id, { tool: name, agent: agentId }));
      },
      onDelta: delta => emit("delta", { text: delta }),
      onReset: discardChars => emit("reset", { discardChars }),
      ...(flags.style ? { style: true } : {}),
      ...(memory ? { memoryFacts: memory.facts, extraTools: [memory.tool] } : {}),
      ...(job && jobs ? {
        takeFollowUps: (max: number): Promise<OwnerFollowUp[]> => jobs.takeAgentJobInbox(job.id, max),
        onFollowUp: (count: number) => emit("followup", { count }),
      } : {}) });
    let reply: Awaited<ReturnType<typeof persistAgentReply>>;
    try {
      if (!result.text.trim()) throw new AgentEmptyReplyError();
      reply = await persistAgentReply(scope, owner, result);
    } finally {
      // Billable usage must be counted even for blank, oversized or failed writes.
      try { await recordAgentTurnUsage(scope, owner, result); }
      catch { console.error("agent_usage_write_failed"); } // no owner data logged
      const style = flags.style ? styleReport(result.text) : null;
      console.info("agent_turn",{turn:"agent",endReason:result.endReason,status:result.status.status,
        modelCalls:result.usage.modelCalls,toolCalls:result.usage.toolCalls,
        tools:result.tools??[],latencyMs:result.usage.latencyMs,
        unverifiedCount:result.unverified.length,
        ...(job ? { followUps: result.absorbedOwnerMessageIds?.length ?? 0 } : {}),
        ...(style ? { sentences: style.sentences, styleTooLong: style.tooLong, styleFiller: style.filler } : {})});
      logged=true;
    }
    await steps;
    emit("done", { reply, status: result.status, endReason: result.endReason,
      unverified: result.unverified, usage: result.usage,
      ...(job ? { jobId: job.id, absorbedOwnerMessageIds: result.absorbedOwnerMessageIds ?? [] } : {}) });
    return { replyId: reply.id };
  } catch (error) {
    if(!logged)console.info("agent_turn",{turn:"agent",endReason:"error",status:"unavailable",
      modelCalls:0,toolCalls:0,tools:[],latencyMs:Date.now()-startedAt,unverifiedCount:0});
    const code = errorCode(error);
    console.error("agent_sse_error",{code});
    emit("error", { code, ...(error instanceof AgentEmptyReplyError ? { retryable: true } : {}),
      ...(job ? { jobId: job.id } : {}) });
    return { errorCode: code };
  } finally { await steps.catch(() => undefined); }
}

/** CHAT_MEMORY: approved café facts + the draft-only memory tool (RLS client). */
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
    const flags = chatExperienceFlags();
    const base = { scope, threadId: id, owner, ownerText: input.text, locale: input.locale, service, flags };

    if (prior) return sseStream((emit, close) => { emit("done", { reply: prior, replayed: true }); close(); });

    if (!flags.jobs) {
      // Default path (flag off): the turn lives inside this response, as before.
      return sseStream(async (emit, close) => {
        try { await runOneTurn({ ...base, emit, job: null, jobs: null }); } finally { close(); }
      });
    }

    // CHAT_JOBS: the turn is a background job that outlives this response.
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
          const outcome = await runOneTurn({ ...base, owner, ownerText, emit: sink.emit, job, jobs });
          let next: AgentJob | null = null;
          try {
            next = (await jobs.finishAgentJob(job.id, "replyId" in outcome
              ? { status: "done", replyMessageId: outcome.replyId }
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
