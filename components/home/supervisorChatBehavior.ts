import type { ConversationMessage, ConversationPage } from "@/lib/ai/conversations/contracts";
import {richPresentationSchema} from "@/lib/ai/conversations/presentation";

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
export function clarifyCardState(messages:readonly ConversationMessage[],index:number,activeDurableQuestions?:ReadonlySet<string>){
  const message=messages[index];
  const card=message?.blocks?.find(b=>b&&typeof b==="object"&&"type" in b&&b.type==="clarify");
  if(!card||typeof card!=="object")return {state:"hidden" as const,choice:null};
  // Every card kind is shown. A reply that is only a question is saved as the card
  // alone (no text block), so hiding a card would leave an empty answer bubble.
  // Typed-answer cards (facts, fill) have no options to match a reply against.
  const options="options" in card&&Array.isArray(card.options)?card.options:[];
  const durableId=message.grounding?.durableQuestionId;
  if(typeof durableId==="string"){
    const matched=messages.slice(index+1).find(m=>m.role==="owner"&&m.ownerInputResponse?.questionId===durableId);
    if(matched)return {state:"chosen" as const,choice:matched.text};
    return activeDurableQuestions?.has(durableId)?{state:"active" as const,choice:null}:{state:"skipped" as const,choice:null};
  }
  const next=messages.slice(index+1).find(m=>m.role==="owner");
  if(next){
    const label=options.find(o=>o&&typeof o==="object"&&"label" in o&&o.label===next.text);
    return label?{state:"chosen" as const,choice:String(label.label)}:{state:"skipped" as const,choice:null};
  }
  return messages.at(-1)?.id===message.id?{state:"active" as const,choice:null}:{state:"skipped" as const,choice:null};
}

/** Keep one copy of an old experiment when a deep link has its own focused
 * proposal panel. Do not hide unrelated cards or cards from other threads. */
export function isDuplicateLinkedExperimentCard(
  block:unknown,messageThreadId:string,linkedThreadId?:string,linkedProposalId?:string,
):boolean{
  if(!linkedThreadId||!linkedProposalId||messageThreadId!==linkedThreadId||
    !block||typeof block!=="object"||Array.isArray(block))return false;
  return "type" in block&&block.type==="experiment_card"&&
    "proposalId" in block&&block.proposalId===linkedProposalId;
}

/** The API returns chronological pages. A latest-page refresh may overlap
 * the older pages already read in the current thread; preserve those
 * contiguous records, replacing every overlapping record with fresh evidence.
 * An entirely new/nonoverlapping page must not create a fabricated history gap. */
export function mergeLatestConversationPage(previous:ConversationPage<ConversationMessage>,fresh:ConversationPage<ConversationMessage>):ConversationPage<ConversationMessage>{
  if(fresh.nextOffset===null||!fresh.items.length||!previous.items.length)return fresh;
  const threadId=fresh.items[0].threadId;
  if(previous.items.some(m=>m.threadId!==threadId)||fresh.items.some(m=>m.threadId!==threadId))return fresh;
  const overlap=previous.items.findIndex(m=>m.id===fresh.items[0].id);
  if(overlap<0)return fresh;
  const freshIds=new Set(fresh.items.map(m=>m.id));
  const prefix=previous.items.slice(0,overlap).filter(m=>!freshIds.has(m.id));
  return {items:[...prefix,...fresh.items],nextOffset:previous.nextOffset===null?null:fresh.nextOffset+prefix.length};
}

/** Index only already-authorized persisted messages loaded in this conversation.
 * The original answer remains the report; this is not another store or receipt. */
export function loadedSavedReports(messages:readonly ConversationMessage[],threadId:string|null){
  if(!threadId)return [];
  return messages.flatMap(message=>{
    if(message.threadId!==threadId||message.role!=="supervisor")return [];
    const presentations=(message.blocks??[]).flatMap(block=>{
      const parsed=richPresentationSchema.safeParse(block);
      return parsed.success&&parsed.data.report?[parsed.data]:[];
    });
    if(!presentations.length)return [];
    const first=presentations[0];
    return [{id:message.id,createdAt:message.createdAt,title:first.panels[0]?.title??first.tables?.[0]?.title??first.agenda?.title??first.scenario?.title??first.calculator?.title??null}];
  }).reverse();
}

/** Retain the selected conversation on reload without a second server navigation
 * or a new browser history entry. An explicit blank chat is not "resume latest".
 * A linked experiment belongs only to its original thread. */
export function conversationLocation(href:string,threadId:string|null):string{
  const url=new URL(href);
  url.searchParams.delete("experiment");
  if(threadId){url.searchParams.set("thread",threadId);url.searchParams.delete("newChat");}
  else{url.searchParams.delete("thread");url.searchParams.set("newChat","1");}
  return url.pathname+url.search+url.hash;
}
