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

/** Viewport-only scroll policy: new conversations start at the beginning,
 * outgoing turns follow the latest message, and older history keeps its anchor. */
export function transcriptScrollTarget({
  scrollTop, scrollHeight, previousScrollHeight, openAtTop, followLatest,
}: {
  scrollTop: number; scrollHeight: number; previousScrollHeight: number | null;
  openAtTop: boolean; followLatest: boolean;
}): number | null {
  if (previousScrollHeight !== null) return scrollTop + scrollHeight - previousScrollHeight;
  if (openAtTop) return 0;
  return followLatest ? scrollHeight : null;
}
