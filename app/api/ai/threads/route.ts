import { authenticatedConversationService } from "@/lib/ai/conversations/auth.server";
import { createThreadInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const service = await authenticatedConversationService();
    return conversationJson({ threads: await service.listThreads() });
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
