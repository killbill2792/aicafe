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
    const query = () => client.from("ai_agent_jobs")
      .select("id, thread_id, owner_message_id, status, attempt, error_code, reply_message_id, progress, inbox, consumed, heartbeat_at, created_at")
      .eq("business_id", scope.businessId).eq("thread_id", id);
    // Retries reuse their original row/created_at: a newer completed job must
    // never hide an older row that is running again.
    const running = await query().eq("status", "running")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (running.error) throw running.error;
    const latest = running.data ? running : await query().in("status", ["done", "failed"])
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    return conversationJson({ job: latest.data ? effectiveAgentJob(toAgentJob(latest.data)) : null });
  } catch (error) { return conversationError(error); }
}
