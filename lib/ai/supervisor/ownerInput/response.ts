import {randomUUID} from "node:crypto";
import type {GroundedSupervisorReply} from "@/lib/ai/conversations/contracts";
import {ownerInputRequestSchema,type PendingOwnerInput,type OwnerInputRequest,
  type OwnerQuestion} from "./contracts";

export function buildOwnerQuestionReply(input:{
  businessId:string;originalText:string;readCapabilityId:string;readInput:unknown;
  request:OwnerInputRequest;questionId?:string;
}):GroundedSupervisorReply{
  const request=ownerInputRequestSchema.parse(input.request);
  const questionId=input.questionId??randomUUID();
  const ownerInput:PendingOwnerInput={version:1,questionId,stage:"answer",
    businessId:input.businessId,originalText:input.originalText,
    readCapabilityId:input.readCapabilityId,readInputJson:JSON.stringify(input.readInput),
    request,answer:null,summary:null};
  const card:OwnerQuestion={type:"owner_question",questionId,title:request.question,input:request.input};
  return {intent:"unknown",status:"requires_owner_input",evidence:[],
    blocks:[card],ownerInput};
}
export function confirmOwnerQuestion(pending:PendingOwnerInput,
  answer:string,summary:Record<"en"|"es"|"ar",string>):GroundedSupervisorReply{
  const next:PendingOwnerInput={...pending,stage:"confirm",answer,summary};
  return {intent:"unknown",status:"requires_owner_input",evidence:[],ownerInput:next,
    blocks:[{type:"owner_question",questionId:pending.questionId,title:summary,
      input:{kind:"options",options:[
        {id:"confirm",label:{en:"Save this value",es:"Guardar este valor",ar:"حفظ هذه القيمة"}},
        {id:"dismiss",label:{en:"Not now",es:"Ahora no",ar:"ليس الآن"}},
      ]}}]};
}
export function declinedOwnerQuestion(locale:"en"|"es"|"ar"):GroundedSupervisorReply{
  return {intent:"unknown",status:"insufficient_evidence",evidence:[],
    blocks:[{type:"text",text:{en:"Nothing was saved. You can return to the question later.",
      es:"No se guardó nada. Puedes volver a esta pregunta cuando quieras.",
      ar:"لم يتم حفظ أي شيء. يمكنك العودة إلى السؤال لاحقًا."}[locale]}]};
}
