import { authenticatedConversationService } from "@/lib/ai/conversations/auth.server";
import { addOwnerMessageInput, messagePageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ threadId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const query = new URL(request.url).searchParams;
    const page = parseInput(messagePageInput, { offset: query.get("offset") ?? undefined });
    const service = await authenticatedConversationService();
    const messages = await service.listMessages(id, page.offset);
    return conversationJson(messages);
  } catch (error) {
    return conversationError(error);
  }
}

/** Appends a real owner message only; Phase 4 adds grounded Supervisor replies. */
export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const input = parseInput(addOwnerMessageInput, await readBoundedJson(request));
    const service = await authenticatedConversationService();
    const message = await service.addOwnerMessage(id, input.clientMessageId, input.text);
    return conversationJson({ message, replyStatus: "not_enabled" }, 201);
  } catch (error) {
    return conversationError(error);
  }
}
