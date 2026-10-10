import { authenticatedConversationService } from "@/lib/ai/conversations/auth.server";
import { createThreadInput, pageInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const offset = parseInput(pageInput, { offset: new URL(request.url).searchParams.get("offset") ?? undefined }).offset;
    const service = await authenticatedConversationService();
    return conversationJson(await service.listThreads(offset));
  } catch (error) {
    return conversationError(error);
  }
}

/** Creates an empty durable thread; does not call an LLM or claim an AI answer. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const input = parseInput(createThreadInput, await readBoundedJson(request));
    const service = await authenticatedConversationService();
    const thread = await service.createThread(input.requestId, input.title);
    return conversationJson({ thread }, 201);
  } catch (error) {
    return conversationError(error);
  }
}
