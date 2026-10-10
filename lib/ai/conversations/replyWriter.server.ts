import "server-only";
import { createHash } from "node:crypto";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { ConversationMessage, ConversationScope, GroundedSupervisorReply } from "./contracts";
import { groundedReplySchema } from "./contracts";

const COLUMNS = "id, thread_id, role, content_type, text_content, structured_content, grounding, client_message_id, created_at";

function replyIdFor(ownerMessageId: string): string {
  const hex = createHash("sha256").update("ai-cafe:supervisor-reply:v1:" + ownerMessageId).digest("hex");
  // Stable UUID for exactly one reply per persisted owner message. Retries never
  // produce duplicate Supervisor messages or rewrite a previously grounded reply.
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) +
    "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}

function convertRow(row: Record<string, unknown>): ConversationMessage {
  return {
    id: String(row.id), threadId: String(row.thread_id),
    role: "supervisor", contentType: "blocks", text: null,
    blocks: row.structured_content as unknown[],
    grounding: row.grounding as Record<string, unknown>,
    clientMessageId: null, createdAt: String(row.created_at),
  };
}

function validateReply(reply: GroundedSupervisorReply): GroundedSupervisorReply {
  const validated = groundedReplySchema.parse(reply);
  if (validated.status !== "insufficient_evidence" && validated.evidence.length === 0) {
    throw new Error("Supervisor response requires trusted evidence");
  }
  if (validated.status === "insufficient_evidence" &&
      validated.blocks.some((block) => block.type === "metric" || block.type === "task_status")) {
    throw new Error("Insufficient evidence cannot contain factual metrics or task claims");
  }
  for (const block of validated.blocks) {
    if ((block.type === "metric" || block.type === "task_status") &&
        !validated.evidence.some((e) => e.source === block.source.source &&
          e.identifier === block.source.identifier && e.asOf === block.source.asOf)) {
      throw new Error("Metric or task is missing its exact grounding reference");
    }
  }
  return validated;
}

/** Caller must have completed authenticatedConversationContext() and
 * ConversationService.addOwnerMessage(). Never expose this to a client/route
 * as a generic assistant-insert function.
 */
export async function getExistingSupervisorReply(
  scope: ConversationScope, ownerMessage: ConversationMessage,
): Promise<ConversationMessage | null> {
  if (ownerMessage.role !== "owner" || ownerMessage.contentType !== "text" ||
      !ownerMessage.clientMessageId) throw new Error("Supervisor reply requires a recorded owner message");
  const id = replyIdFor(ownerMessage.id);
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from("ai_messages").select(COLUMNS)
    .eq("id", id).eq("business_id", scope.businessId)
    .eq("owner_user_id", scope.ownerUserId)
    .eq("thread_id", ownerMessage.threadId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.role !== "supervisor" || data.grounding?.ownerMessageId !== ownerMessage.id) {
    throw new Error("Supervisor message provenance mismatch");
  }
  return convertRow(data);
}

export async function persistGroundedSupervisorReply(
  scope: ConversationScope,
  ownerMessage: ConversationMessage,
  reply: GroundedSupervisorReply,
): Promise<ConversationMessage> {
  if (ownerMessage.role !== "owner" || ownerMessage.contentType !== "text" ||
      !ownerMessage.clientMessageId) throw new Error("Cannot respond without an owner message");
  const safe = validateReply(reply);
  const existing = await getExistingSupervisorReply(scope, ownerMessage);
  if (existing) return existing;
  const admin = createAdminSupabaseClient();
  const id = replyIdFor(ownerMessage.id);
  const grounding = {
    status: safe.status,
    intent: safe.intent,
    evidence: safe.evidence,
    ownerMessageId: ownerMessage.id,
    responder: "deterministic-structured-cafe-tools-v1",
  };
  const { data, error } = await admin.from("ai_messages").insert({
    id, business_id: scope.businessId, owner_user_id: scope.ownerUserId,
    thread_id: ownerMessage.threadId, author_user_id: null,
    role: "supervisor", content_type: "blocks", text_content: null,
    client_message_id: null, structured_content: safe.blocks, grounding,
  }).select(COLUMNS).single();
  if (error) {
    if (error.code === "23505") {
      const replay = await getExistingSupervisorReply(scope, ownerMessage);
      if (replay) return replay;
    }
    throw error;
  }
  return convertRow(data);
}
