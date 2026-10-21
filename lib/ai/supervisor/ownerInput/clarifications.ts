import {randomUUID} from "node:crypto";
import type {GroundedSupervisorReply} from "@/lib/ai/conversations/contracts";
import type {InvestigationAnswer} from "../investigation/protocol";
import type {OwnerQuestion} from "./contracts";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
type Locale="en"|"es"|"ar";
export type KnownClarificationOption={id:string;label:Record<Locale,string>};

/** Presentation-only bridge for the EXISTING ambiguity/clarification logic.
 * Called only after the independent semantic reviewer approved the text.
 * No new interpretation, identity guess or write permission is created here. */
export function adaptReviewedClarifications(reply:GroundedSupervisorReply,
  answer:InvestigationAnswer,locale:Locale,verifiedOptions:readonly KnownClarificationOption[]=[]):
    GroundedSupervisorReply{
  const approvedQuestions=new Set(answer.paragraphs.filter(p=>p.kind==="clarification"&&
    p.citations.length===0).map(p=>p.text.trim()));
  if(!approvedQuestions.size)return reply;
  const hints={en:en.SupervisorChat.ownerInputAnswer,
    es:es.SupervisorChat.ownerInputAnswer,ar:ar.SupervisorChat.ownerInputAnswer};
  const validOptions=verifiedOptions.length>=2&&verifiedOptions.length<=30&&
    verifiedOptions.every(o=>o.id&&o.label.en&&o.label.es&&o.label.ar);
  return {...reply,blocks:reply.blocks.map(block=>{
    if(block.type!=="text"||!approvedQuestions.has(block.text.trim()))return block;
    const question:OwnerQuestion={type:"owner_question",questionId:randomUUID(),
      title:{en:block.text.slice(0,240),es:block.text.slice(0,240),ar:block.text.slice(0,240)},
      input:validOptions?
        {kind:"options",options:[...verifiedOptions]}:
        {kind:"free_text",hint:hints},
    };
    return question;
  })};
}
