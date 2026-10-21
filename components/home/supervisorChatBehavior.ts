import {pendingOwnerInputSchema} from "@/lib/ai/supervisor/ownerInput/contracts";
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

/** Only a question on the latest message is interactive. Older cards remain
 * readable history, never another write/clarification action. */
export function activeOwnerQuestionMessageId(messages:readonly ConversationMessage[]):string|null{
  const last=messages.at(-1);
  if(last?.role!=="supervisor")return null;
  return last.blocks?.some(block=>typeof block==="object"&&block!==null&&
    "type" in block&&block.type==="owner_question")?last.id:null;
}

/** Match only an answer AFTER the individual card, before a reissued card.
 * The confirm stage deliberately reuses the questionId of its supply stage.
 */
export function answeredOwnerQuestion(messages:readonly ConversationMessage[],
  questionMessage:ConversationMessage,questionId:string):ConversationMessage|null{
 const start=messages.findIndex(m=>m.id===questionMessage.id);
 if(start<0)return null;
 const state=pendingOwnerInputSchema.safeParse(questionMessage.grounding?.ownerInput);
 const stage=state.success?state.data.stage:"answer";
 for(const next of messages.slice(start+1)){
   if(next.role==="supervisor"&&next.blocks?.some(b=>
     typeof b==="object"&&b!==null&&"type" in b&&b.type==="owner_question"&&
     "questionId" in b&&b.questionId===questionId))break;
   if(next.role!=="owner"||next.ownerInputResponse?.questionId!==questionId)continue;
   const action=next.ownerInputResponse.action;
   if((stage==="answer"&&(action==="supply"||action==="dismiss"))||
      (stage==="confirm"&&(action==="confirm"||action==="dismiss")))return next;
 }
 return null;
}
