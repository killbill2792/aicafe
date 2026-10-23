import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput } from "@/lib/ai/conversations/http.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { chatExperienceFlags } from "@/lib/ai/agent/flags";
import { effectiveAgentJob, toAgentJob } from "@/lib/ai/agent/jobState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ threadId: string }> };

/** Latest background turn for this conversation, so a reloaded page can resume.
 * Owner-scoped twice: the conversation service checks the thread, and the RLS
 * client can only read this owner's jobs. Returns {job:null} when CHAT_JOBS is off. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const { scope, service } = await authenticatedConversationContext();
    if (!chatExperienceFlags().jobs) return conversationJson({ job: null });
    await service.getThread(id);
    const client = await createServerSupabaseClient();
    const { data, error } = await client.from("ai_agent_jobs")
      .select("id, thread_id, owner_message_id, status, attempt, error_code, reply_message_id, progress, inbox, consumed, heartbeat_at, created_at")
      .eq("business_id", scope.businessId).eq("thread_id", id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return conversationJson({ job: data ? effectiveAgentJob(toAgentJob(data)) : null });
  } catch (error) { return conversationError(error); }
}
