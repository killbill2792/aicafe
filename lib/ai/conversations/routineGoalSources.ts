import type {ConversationMessage} from "./contracts";

/** Only authenticated, earlier owner-written messages from the exact thread
 * can become saved-goal candidates. The full text stays in ai_messages;
 * these bounded previews never become independent source or effect authority. */
export function routineGoalCandidates(
  messages:readonly ConversationMessage[],
  owner:Pick<ConversationMessage,"id"|"threadId"|"createdAt">,
  ownerText:string,
  includeCurrent=true,
):Array<{id:string;text:string}>{
  const ownerAt=Date.parse(owner.createdAt);
  const sources=Number.isFinite(ownerAt)?messages.filter(m=>
    m.threadId===owner.threadId&&m.id!==owner.id&&m.role==="owner"&&
    typeof m.text==="string"&&m.text.trim().length>0&&
    Number.isFinite(Date.parse(m.createdAt))&&Date.parse(m.createdAt)<=ownerAt
  ).map(m=>({id:m.id,text:m.text!.slice(0,320)})):[];
  return includeCurrent?[...sources,{id:owner.id,text:ownerText.slice(0,320)}]:sources;
}
