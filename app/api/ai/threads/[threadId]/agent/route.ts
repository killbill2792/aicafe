import {authenticatedConversationContext,ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {addOwnerMessageInput,threadIdInput} from "@/lib/ai/conversations/contracts";
import {conversationError,parseInput,readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {registerAuthorizedSupervisorTurn} from "@/lib/ai/conversations/authorizedTurn.server";
import {isSupervisorChatConfigured,getSupervisorChatReadiness} from "@/lib/ai/conversations/enabled.server";
import {assertOwnerAgentTurnAvailable} from "@/lib/ai/conversations/usage.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {runOneTurn,errorCode} from "@/lib/ai/conversations/agentRunner.server";
import {authorizedExternalConversation,storedOwnerMessageChannel} from "@/lib/ai/conversations/authorizedTurn.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import type {AgentJob} from "@/lib/ai/agent/jobState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60s agent deadline + one possible continuation turn + persistence. Only matters
// with background jobs on (the turn keeps running via after() once the owner leaves).
// Vercel: Hobby caps at 60s, Pro/Enterprise allow this (Fluid compute default 300s).
export const maxDuration = 150;
type RouteContext = { params: Promise<{ threadId: string }> };
type Emit = (type: string, data: unknown) => void;
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
    const { owner, prior } = await registerAuthorizedSupervisorTurn({
      scope, service, threadId: id, clientMessageId: input.clientMessageId, text: input.text,
    });
    const base = { scope, threadId: id, owner, ownerText: input.text, locale: input.locale, service,
      attachmentIds:input.attachmentIds??[] };

    if (prior&&!prior.grounding?.durableRunId) return sseStream((emit, close) => { emit("done", { reply: prior, replayed: true }); close(); });

    // Admission is durable before any acknowledgement or execution. The
    // foreground path below and the existing scheduled worker race for the
    // SAME scoped lease, never for independent agent turns.
    if(process.env.SUPERVISOR_RUN_WORKER_ENABLED==="true"&&process.env.SUPERVISOR_DURABLE_CHAT_ENABLED==="true"){
      const worker=await import("@/lib/ai/supervisor/runs/worker.server");
      let run:Awaited<ReturnType<typeof worker.admitDurableChat>>;
      try{run=await worker.admitDurableChat({...scope,threadId:id},owner,{locale:input.locale,attachmentIds:input.attachmentIds??[]});}
      catch(error){
        const cause=error instanceof Error?error.cause:null;
        const code=cause&&typeof cause==="object"&&"code" in cause?String(cause.code):"";
        throw new ConversationApiError(code==="23505"?409:503,code==="23505"?"idempotency_conflict":"conversation_storage_unavailable");
      }
      if(prior)return sseStream((emit,close)=>{emit("done",{reply:prior,replayed:true});close();});
      const jobs=await import("@/lib/ai/agent/jobs.server");
      const sink=createTurnSink();
      return sseStream((emit,close,onCancel)=>{
        const detach=sink.attach({emit,close});onCancel(detach);
        const work=(async()=>{
          try{
            let sentReply=false;
            const state=await worker.processDurableRun(run.id,(type,data)=>{if(type==="done")sentReply=true;sink.emit(type,data);});
            if(state==="busy")sink.emit("queued",{runId:run.id});
            else if(state==="blocked")sink.emit("error",{code:"agent_turn_failed",retryable:false,runId:run.id});
            else if(!sentReply) {
              // An earlier worker may have completed the reply between
              // admission and claim. Replay only the canonical saved answer.
              const {getExistingSupervisorReply}=await import("@/lib/ai/conversations/replyWriter.server");
              const completed=await getExistingSupervisorReply(scope,owner);
              if(completed)sink.emit("done",{reply:completed,replayed:true});
            }
          }catch{sink.emit("error",{code:"agent_turn_failed",retryable:true,runId:run.id});}
          finally{sink.close();}
        })();
        jobs.keepTurnAlive(work);
      });
    }
    // A disabled rollout does not grant authority to replay an admitted v2
    // message through the legacy pipeline.
    if(prior)return sseStream((emit,close)=>{emit("done",{reply:prior,replayed:true});close();});

    // Background jobs are always on; unavailable job storage falls back inline.
    const jobs = await import("@/lib/ai/agent/jobs.server");
    let started: Awaited<ReturnType<JobsModule["startAgentJob"]>>;
    try { started = await jobs.startAgentJob(scope, id, owner.id); }
    catch (error) {
      if(error&&typeof error==="object"&&"message" in error&&error.message==="durable_job_owned")
        throw new ConversationApiError(503,"conversation_storage_unavailable");
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
          const isExternal=process.env.WHATSAPP_SUPERVISOR_ENABLED==="true" &&
            await storedOwnerMessageChannel(scope,id,owner.id)==="whatsapp";
          if(isExternal)await authorizedExternalConversation(scope,id);
          // A queued WhatsApp continuation runs under the same explicit owner
          // scope, never a forged browser session or a separate agent pipeline.
          const outcome = await runOneTurn({ ...base, owner, ownerText,
            attachmentIds:owner.id===base.owner.id?base.attachmentIds:[],emit:sink.emit,job,jobs,
            ...(isExternal?{externalClient:createAdminSupabaseClient()}:{}) });
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
