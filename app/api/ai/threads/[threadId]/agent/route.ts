import {proposalRequestKey} from "@/lib/ai/supervisor/loop/requestKeys";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {menuPriceChangeCapabilityId} from "@/lib/ai/supervisor/loop/menuPriceChange.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { addOwnerMessageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { isSupervisorChatConfigured, getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import type { NumericEvidence } from "@/lib/ai/agent/checkNumbers";
import { runAgentTurn } from "@/lib/ai/agent/loop.server";
import { persistAgentReply, recordAgentTurnUsage, AgentReplyTooLongError, AgentReplyStorageError, AgentEmptyReplyError } from "@/lib/ai/agent/persist.server";
import { labelSupervisorThread, assertOwnerAgentTurnAvailable } from "@/lib/ai/conversations/usage.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 70;
type RouteContext = { params: Promise<{ threadId: string }> };
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
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (type: string, data: unknown) => {
          controller.enqueue(encoder.encode("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n"));
        };
        let logged=false;
        const startedAt=Date.now();
        try {
          if (prior) {
            emit("done", { reply: prior, replayed: true });
            return;
          }
          const [tools, identity, page] = await Promise.all([
            createAuthenticatedCafeTools(), readSupervisorCafeIdentity(scope.businessId), service.listMessages(id, 0),
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
          // Retain only typed evidence from successful tool reads.
          const history = page.items.filter(m => m.id !== owner.id &&
            (m.role === "owner" || m.role === "supervisor")).slice(-8)
            .map(m => ({ role: m.role === "owner" ? "user" as const : "assistant" as const,
              content: m.text ?? (m.blocks ?? []).flatMap(b => b && typeof b === "object" && "text" in b ?
                [String(b.text)] : []).join(" ") })).filter(m => m.content);
          const result = await runAgentTurn({ ownerText: input.text, history,
            context: { tools, asOf: identity.asOf, locale: input.locale,timezone:identity.timezone,
              threadId:id,ownerMessageId:owner.id,
              proposals:{proposePriceChange:async({productId,newPriceCents})=>{
                const stable=JSON.stringify({ownerMessageId:owner.id,productId,newPriceCents});
                // RFC 4122 UUIDv5: the thread UUID is the namespace.
                const requestKey=proposalRequestKey(id,stable);
                const proposal=await proposeLoop({...scope,threadId:id,locale:input.locale},
                  supervisorLoopRegistry,new SupabaseLoopRepository(),menuPriceChangeCapabilityId,
                  {productId,newPriceCents},requestKey);
                const effect=proposal.canonicalEffectPayload as {
                  productName:string;oldPriceCents:number;newPriceCents:number};
                return {proposalId:proposal.id,revision:proposal.revision,
                  productName:effect.productName,oldPriceCents:effect.oldPriceCents,
                  newPriceCents:effect.newPriceCents};
              }} },
            previousEvidence,onTool:(name,agentId)=>emit("tool",{name,agentId}),
            onDelta: delta => emit("delta", { text: delta }),
            onReset: discardChars => emit("reset", { discardChars }) });
          let reply: Awaited<ReturnType<typeof persistAgentReply>>;
          try {
            if (!result.text.trim()) throw new AgentEmptyReplyError();
            reply = await persistAgentReply(scope, owner, result);
          } finally {
            // Billable usage must be counted even for blank, oversized or failed writes.
            try { await recordAgentTurnUsage(scope, owner, result); }
            catch { console.error("agent_usage_write_failed"); } // no owner data logged
            console.info("agent_turn",{turn:"agent",endReason:result.endReason,status:result.status.status,
              modelCalls:result.usage.modelCalls,toolCalls:result.usage.toolCalls,
              tools:result.tools??[],latencyMs:result.usage.latencyMs,
              unverifiedCount:result.unverified.length});
            logged=true;
          }

          emit("done", { reply, status: result.status, endReason: result.endReason,
            unverified: result.unverified, usage: result.usage });
        } catch (error) {
          if(!logged)console.info("agent_turn",{turn:"agent",endReason:"error",status:"unavailable",
            modelCalls:0,toolCalls:0,tools:[],latencyMs:Date.now()-startedAt,unverifiedCount:0});
          const code = error instanceof ConversationApiError ? error.code :
            error instanceof AgentReplyTooLongError ? "reply_too_long" :
            error instanceof AgentReplyStorageError ? "reply_storage_failed" :
            error instanceof AgentEmptyReplyError ? "agent_turn_failed" :
            "agent_turn_failed";
          console.error("agent_sse_error",{code});
          emit("error", { code, ...(error instanceof AgentEmptyReplyError ? { retryable: true } : {}) });
        } finally { controller.close(); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) { return conversationError(error); }
}
