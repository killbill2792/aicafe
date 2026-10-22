import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { supervisorReplyIdFor } from "@/lib/ai/conversations/replyValidation";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import type { ConversationMessage, ConversationScope } from "@/lib/ai/conversations/contracts";
import type { AgentTurn } from "./loop.server";

/** Persist ordinary prose without passing through retired supervisor evidence gates. */
export async function persistAgentReply(scope: ConversationScope, owner: ConversationMessage, turn: AgentTurn) {
  const existing = await getExistingSupervisorReply(scope, owner);
  if (existing) return existing;
  const admin = createAdminSupabaseClient();
  const text = turn.text.trim();
  const { error } = await admin.from("ai_messages").insert({
    id: supervisorReplyIdFor(owner.id), business_id: scope.businessId,
    owner_user_id: scope.ownerUserId, thread_id: owner.threadId,
    author_user_id: null, role: "supervisor", content_type: "blocks",
    text_content: null, client_message_id: null,
    structured_content: [{ type: "text", text: text.slice(0, 1200) || " " }],
    grounding: { ownerMessageId: owner.id, responder: "single-streaming-agent-v1",
      status: turn.status.status, missing: turn.status.missing,
      unverified: turn.unverified, endReason: turn.endReason,
      sources: turn.results.map(r => ({ source: r.source, period: r.period, missing: r.missing })) },
  });
  if (error && error.code !== "23505") throw error;
  const saved = await getExistingSupervisorReply(scope, owner);
  if (!saved) throw new Error("agent_reply_storage_failed");
  return saved;
}
