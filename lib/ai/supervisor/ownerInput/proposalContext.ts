import type {ConversationMessage} from "@/lib/ai/conversations/contracts";
import {ownerInputResponseSchema,pendingOwnerInputSchema} from "./contracts";
import {prepareOwnerResolution} from "./resolution";

/** A structured reply is a genuine owner statement only when it was accepted
 * against an earlier issued question. An option's UUID or generated display
 * label is NEVER owner-authored hypothetical or price-amount evidence. */
export function validatedOwnerAnswerText(messages:readonly ConversationMessage[],
  owner:ConversationMessage,businessId?:string):string|null{
  const response=ownerInputResponseSchema.safeParse(owner.ownerInputResponse);
  if(!response.success||response.data.action!=="supply"||!response.data.value)return null;
  const issued=messages.find(message=>{
    if(message.role!=="supervisor"||message.createdAt>owner.createdAt)return false;
    const prior=pendingOwnerInputSchema.safeParse(message.grounding?.ownerInput);
    return prior.success&&prior.data.questionId===response.data.questionId&&
      (businessId===undefined||prior.data.businessId===businessId)&&
      prior.data.stage==="answer"&&prior.data.request.mode==="resolve";
  });
  const pending=pendingOwnerInputSchema.safeParse(issued?.grounding?.ownerInput);
  if(!pending.success)return null;
  const prepared=prepareOwnerResolution(pending.data.request,response.data.value);
  if(!prepared)return null;
  const input=pending.data.request.input;
  if(input.kind==="options"&&input.options.some(o=>o.id===prepared.answer))return null;
  return prepared.answer;
}

/** Price proposals use only original owner messages and validated free-text
 * answers; option labels/IDs and forged or unrelated answer cards are excluded. */
export function ownerAuthoredProposalTexts(messages:readonly ConversationMessage[],
  currentMessageId:string,businessId:string):string[]{
  return messages.filter(m=>m.role==="owner"&&m.id!==currentMessageId)
    .sort((a,b)=>(b.createdAt??"").localeCompare(a.createdAt??""))
    .flatMap(m=>{
      if(!m.ownerInputResponse)return typeof m.text==="string"?[m.text]:[];
      const answer=validatedOwnerAnswerText(messages,m,businessId);
      return answer?[answer]:[];
    }).slice(0,5);
}
