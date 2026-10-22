import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { addOwnerMessageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { isSupervisorChatConfigured, getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import { runAgentTurn } from "@/lib/ai/agent/loop.server";
import { persistAgentReply } from "@/lib/ai/agent/persist.server";
import { labelSupervisorThread } from "@/lib/ai/conversations/usage.server";

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
        try {
          if (prior) {
            emit("done", { reply: prior, replayed: true });
            return;
          }
          const [tools, identity, page] = await Promise.all([
            createAuthenticatedCafeTools(), readSupervisorCafeIdentity(scope.businessId), service.listMessages(id, 0),
          ]);
          const history = page.items.filter(m => m.id !== owner.id &&
            (m.role === "owner" || m.role === "supervisor")).slice(-8)
            .map(m => ({ role: m.role === "owner" ? "user" as const : "assistant" as const,
              content: m.text ?? (m.blocks ?? []).flatMap(b => b && typeof b === "object" && "text" in b ?
                [String(b.text)] : []).join(" ") })).filter(m => m.content);
          const result = await runAgentTurn({ ownerText: input.text, history,
            context: { tools, asOf: identity.asOf, locale: input.locale },
            onDelta: delta => emit("delta", { text: delta }) });
          const reply = await persistAgentReply(scope, owner, result);
          emit("done", { reply, status: result.status, endReason: result.endReason,
            unverified: result.unverified, usage: result.usage });
        } catch (error) {
          const code = error instanceof ConversationApiError ? error.code :
            error instanceof Error && error.message === "agent_reply_too_long" ? "reply_too_long" :
            error instanceof Error && /storage|insert|database|writer/.test(error.message) ? "reply_storage_failed" :
            "agent_turn_failed";
          emit("error", { code });
        } finally { controller.close(); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) { return conversationError(error); }
}
