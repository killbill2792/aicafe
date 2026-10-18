import { z } from "zod";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput } from "@/lib/ai/conversations/http.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ threadId: string }> };

const clientMessageIdInput = z.uuid();

/** Best-effort live status for the chat composer while the owner's POST is
 * still in flight ("Alex is checking your pricing…"). RLS alone authorizes
 * this read; a missing or stale row is not an error, just an empty status. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const clientMessageId = parseInput(clientMessageIdInput,
      new URL(request.url).searchParams.get("clientMessageId"));
    const { scope } = await authenticatedConversationContext();
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("ai_supervisor_progress")
      .select("agent,stage,updated_at")
      .eq("thread_id", id).eq("client_message_id", clientMessageId)
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
      .maybeSingle();
    if (error) throw error;
    return conversationJson(data ?? null);
  } catch (error) {
    return conversationError(error);
  }
}
