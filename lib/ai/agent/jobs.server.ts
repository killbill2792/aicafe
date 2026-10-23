import "server-only";
import { after } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { ConversationMessage, ConversationScope } from "@/lib/ai/conversations/contracts";
import { toAgentJob, type AgentJob, type AgentJobStartMode, type AgentJobStep } from "./jobState";
import type { OwnerFollowUp } from "./loop.server";

/** Server side of background chat turns (CHAT_JOBS). All writes go through the
 * service-role-only RPCs in migration 20261023000085; owners can only read. */
export async function startAgentJob(scope: ConversationScope, threadId: string, ownerMessageId: string):
  Promise<{ mode: AgentJobStartMode; job: AgentJob }> {
  const { data, error } = await createAdminSupabaseClient().rpc("ai_agent_job_start", {
    p_business_id: scope.businessId, p_owner_user_id: scope.ownerUserId,
    p_thread_id: threadId, p_owner_message_id: ownerMessageId,
  });
  if (error) throw error;
  const value = data as { mode: AgentJobStartMode; job: unknown };
  return { mode: value.mode, job: toAgentJob(value.job) };
}

/** Best-effort: a lost step only means a less detailed progress list. Never throws. */
export async function recordAgentJobStep(jobId: string, step: AgentJobStep): Promise<void> {
  try {
    const { error } = await createAdminSupabaseClient().rpc("ai_agent_job_progress", { p_job_id: jobId, p_step: step });
    if (error) throw error;
  } catch { console.error("agent_job_progress_failed"); }
}

export async function takeAgentJobInbox(jobId: string, max: number): Promise<OwnerFollowUp[]> {
  if (max <= 0) return [];
  const { data, error } = await createAdminSupabaseClient().rpc("ai_agent_job_take_inbox", { p_job_id: jobId, p_limit: max });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).flatMap((m: { id?: unknown; text?: unknown }) =>
    typeof m.id === "string" && typeof m.text === "string" ? [{ id: m.id, text: m.text }] : []);
}

/** Exactly-once finish (the RPC ignores a second finish). Retried once because a job
 * stuck in "running" would block the thread until the 180s stale timeout. */
export async function finishAgentJob(jobId: string, outcome: { status: "done"; replyMessageId: string } |
  { status: "failed"; errorCode: string }): Promise<{ continuation: AgentJob | null }> {
  const params = { p_job_id: jobId, p_status: outcome.status,
    p_reply_message_id: outcome.status === "done" ? outcome.replyMessageId : null,
    p_error_code: outcome.status === "failed" ? outcome.errorCode : null };
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await createAdminSupabaseClient().rpc("ai_agent_job_finish", params);
    if (!error) {
      const continuation = (data as { continuation?: unknown } | null)?.continuation;
      return { continuation: continuation ? toAgentJob(continuation) : null };
    }
    if (attempt >= 1) throw error;
  }
}

/** Reads one owner message (for a continuation turn) with the same provenance checks
 * as the reply writer: same café, same owner, same thread, owner role. */
export async function readOwnerMessage(scope: ConversationScope, threadId: string, messageId: string): Promise<ConversationMessage> {
  const { data, error } = await createAdminSupabaseClient().from("ai_messages")
    .select("id, thread_id, role, content_type, text_content, client_message_id, created_at")
    .eq("id", messageId).eq("thread_id", threadId).eq("business_id", scope.businessId)
    .eq("owner_user_id", scope.ownerUserId).eq("role", "owner").single();
  if (error) throw error;
  return { id: String(data.id), threadId: String(data.thread_id), role: "owner", contentType: "text",
    text: String(data.text_content), blocks: null, grounding: null,
    clientMessageId: String(data.client_message_id), createdAt: String(data.created_at) };
}

/** Keeps the turn running after the owner disconnects: Next's after() extends the
 * function lifetime (up to the route's maxDuration) on Vercel and self-hosted Node. */
export function keepTurnAlive(work: Promise<unknown>): void {
  try { after(work); }
  catch { /* outside a request scope (tests/scripts): the promise still runs to completion */ }
}
