import type {ConversationMessage} from "@/lib/ai/conversations/contracts";
import {ownerInputResponseSchema,pendingOwnerInputSchema} from "./contracts";

/** Prior owner-authored text can support a proposal across several questions.
 * Generated option labels and selected IDs must NEVER be amount evidence.
 * Bind every structured free-text statement to its issued same-business card. */
export function ownerAuthoredProposalTexts(messages:readonly ConversationMessage[],
  currentMessageId:string,businessId:string):string[]{
  const questions=messages.filter(m=>m.role==="supervisor").flatMap(m=>{
    const parsed=pendingOwnerInputSchema.safeParse(m.grounding?.ownerInput);
    return parsed.success&&parsed.data.businessId===businessId&&
      parsed.data.stage==="answer"&&parsed.data.request.mode==="resolve"?
      [{message:m,question:parsed.data}]:[];
  });
  return messages.filter(m=>m.role==="owner"&&m.id!==currentMessageId)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
    .flatMap(m=>{
      if(!m.ownerInputResponse)return typeof m.text==="string"?[m.text]:[];
      const supplied=ownerInputResponseSchema.safeParse(m.ownerInputResponse);
      if(!supplied.success||supplied.data.action!=="supply"||!supplied.data.value)return [];
      const issued=questions.find(q=>q.question.questionId===supplied.data.questionId&&
        q.message.createdAt<=m.createdAt);
      if(!issued)return [];
      const value=supplied.data.value.trim();
      const input=issued.question.request.input;
      if(input.kind==="options"&&input.options.some(o=>o.id===value))return [];
      return value?[value]:[];
    }).slice(0,5);
}
