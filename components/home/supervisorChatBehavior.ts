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

/** An SSE delta must not consume the pending history anchor. Only the version
 * advanced alongside the committed history messages authorizes adjustment. */
export function hasInsertedHistoryPage(renderedVersion: number, appliedVersion: number): boolean {
  return renderedVersion !== appliedVersion;
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

/** A clarify card can be answered only once, by the immediately following owner turn. */
export function clarifyCardState(messages:readonly ConversationMessage[],index:number){
  const message=messages[index];
  const card=message?.blocks?.find(b=>b&&typeof b==="object"&&"type" in b&&b.type==="clarify");
  if(!card||typeof card!=="object"||!("options" in card)||!Array.isArray(card.options))return {state:"hidden" as const,choice:null};
  const next=messages.slice(index+1).find(m=>m.role==="owner");
  if(next){
    const label=card.options.find(o=>o&&typeof o==="object"&&"label" in o&&o.label===next.text);
    return label?{state:"chosen" as const,choice:String(label.label)}:{state:"skipped" as const,choice:null};
  }
  return messages.at(-1)?.id===message.id?{state:"active" as const,choice:null}:{state:"skipped" as const,choice:null};
}
