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

/** A scroll decision, independently testable without simulating browser layout. */
export function transcriptScrollTarget({
  scrollTop, scrollHeight, previousScrollHeight, anchorDelta, userScrolled, openNewest,
}: {
  scrollTop: number; scrollHeight: number; previousScrollHeight: number | null;
  anchorDelta: number | null; userScrolled: boolean; openNewest: boolean;
}): number | null {
  if (previousScrollHeight !== null) return scrollTop + scrollHeight - previousScrollHeight;
  if (!userScrolled && anchorDelta !== null) return Math.max(0, scrollTop + anchorDelta - 12);
  return openNewest ? scrollHeight : null;
}

/** Space needed only during the transition; after a reply, cap the tail to a
 * small portion of the actual transcript viewport rather than permanent 40dvh. */
export function responsiveTailSpace(viewport: number, contentBelowAnchor: number,
  sending: boolean): number {
  const needed = Math.max(0, viewport - contentBelowAnchor - 12);
  return Math.ceil(Math.min(needed, viewport * (sending ? 1 : 0.12)));
}
