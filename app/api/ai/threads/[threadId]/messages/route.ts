import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { pageInput, threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ threadId: string }> };
export async function GET(request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const page = parseInput(pageInput, {offset: new URL(request.url).searchParams.get("offset") ?? undefined});
    const { service } = await authenticatedConversationContext();
    return conversationJson(await service.listMessages(id, page.offset));
  } catch (error) { return conversationError(error); }
}
// Compatibility endpoint while clients migrate; the home composer uses /agent.
export { POST } from "../agent/route";
