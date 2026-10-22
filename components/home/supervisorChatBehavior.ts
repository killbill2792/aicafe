import type { ConversationMessage } from "@/lib/ai/conversations/contracts";

export type OptimisticOwner = { id: string; text: string; clientMessageId: string };

/** A local view-only bubble; the API remains the sole writer of durable turns. */
export function beginOptimisticOwner(text: string, clientMessageId: string): OptimisticOwner {
  return { id: "pending:" + clientMessageId, text, clientMessageId };
}

export function sendKey(existingKey: string | undefined, pendingKey: string | null,
  makeKey: () => string): string {
  return existingKey ?? pendingKey ?? makeKey();
}

export function visibleConversationMessages(
  persisted: ConversationMessage[], optimistic: OptimisticOwner | null,
  threadId: string | null, createdAt: string,
): ConversationMessage[] {
  if (!optimistic || persisted.some(m => m.clientMessageId === optimistic.clientMessageId)) return persisted;
  return [...persisted, {
    ...optimistic, threadId: threadId ?? "", role: "owner", contentType: "text",
    blocks: null, grounding: null, createdAt,
  }];
}

/** Tolerate a few pixels of sub-pixel rounding and touch scroll momentum. */
export function isTranscriptNearBottom({
  scrollTop, scrollHeight, clientHeight,
}: { scrollTop: number; scrollHeight: number; clientHeight: number }, threshold = 64): boolean {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

/** Scroll to the actual bottom when pinned; prepend is a separate operation that
 * must preserve the reader's viewport even if the previous state was pinned. */
export function transcriptScrollTarget({
  scrollTop, scrollHeight, clientHeight, previousScrollHeight, pinned,
}: {
  scrollTop: number; scrollHeight: number; clientHeight: number;
  previousScrollHeight: number | null; pinned: boolean;
}): number | null {
  if (previousScrollHeight !== null) {
    return Math.max(0, scrollTop + scrollHeight - previousScrollHeight);
  }
  return pinned ? Math.max(0, scrollHeight - clientHeight) : null;
}

/** Only a question on the latest message is interactive. Older cards remain
 * readable history, never another write/clarification action. */
export function activeOwnerQuestionMessageId(messages:readonly ConversationMessage[]):string|null{
  const last=messages.at(-1);
  if(last?.role!=="supervisor")return null;
  return last.blocks?.some(block=>typeof block==="object"&&block!==null&&
    "type" in block&&block.type==="owner_question")?last.id:null;
}
