import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { addOwnerMessageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { createAuthenticatedCafeTools, readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
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
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    const { scope, service } = await authenticatedConversationContext();
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
          const history = page.items.filter(m => m.id !== owner.id).slice(-8)
            .map(m => ({ role: m.role === "owner" ? "user" as const : "assistant" as const,
              content: m.text ?? (m.blocks ?? []).flatMap(b => b && typeof b === "object" && "text" in b ?
                [String(b.text)] : []).join(" ") })).filter(m => m.content);
          const result = await runAgentTurn({ ownerText: input.text, history,
            context: { tools, asOf: identity.asOf, locale: input.locale },
            onDelta: delta => emit("delta", { text: delta }) });
          const reply = await persistAgentReply(scope, owner, result);
          emit("done", { reply, status: result.status, endReason: result.endReason,
            unverified: result.unverified, usage: result.usage });
        } catch {
          emit("error", { code: "agent_turn_failed" });
        } finally { controller.close(); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) { return conversationError(error); }
}
