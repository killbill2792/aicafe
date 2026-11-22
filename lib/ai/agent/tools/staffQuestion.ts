import {z} from "zod";
import {staffQuestionInput} from "@/lib/staffCommunication/ownerQuestion.contract";
import type {AgentToolContext,AgentToolResult} from "./index";
/** Source-grounded proposal only; the existing effect gateway owns every send. */
export const staffQuestionTools={
 propose_staff_question:{
  agentId:"olivia" as const,schema:staffQuestionInput,
  description:"After reading the actual café evidence and current published schedule, propose asking one linked employee who is scheduled on-shift a narrow factual question. Pass the exact alert or operating-task source type/ID, source/as-of evidence and a future follow-up time. The owner may approve staff contact, ignore, or reply naturally in the existing chat. This tool NEVER sends an employee message or updates stock/roster; unknown facts stay unknown.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=staffQuestionInput.parse(raw);
   try{
    if(!ctx.staffQuestionPropose)throw new Error("staff_question_port_unavailable");
    const proposal=await ctx.staffQuestionPropose(input);
    return {source:"staff_question_proposal",period:null,agentId:"olivia",missing:[],
     draft:true,saved:false,requiredApproval:"owner_click",...proposal};
   }catch{return {source:"staff_question_proposal",period:null,agentId:"olivia",
     missing:["staff_question_source_or_worker_unavailable"],draft:false,saved:false};}
  },
 },
 record_staff_question_owner_answer:{
  agentId:"olivia" as const,
  schema:z.strictObject({proposalId:z.uuid(),revision:z.number().int().positive()}),
  description:"ONLY when the latest authenticated owner chat message directly answers one specific pending staff question in the same thread: record that original saved owner message as owner-reported, unverified evidence. Choose the matching pending proposal ID and revision from the saved question context. If the answer is ambiguous, unrelated, or is asking YOU to contact an employee, do NOT call; clarify instead. This cannot send staff messages or change inventory, staffing or purchases.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const {proposalId,revision}=z.strictObject({proposalId:z.uuid(),revision:z.number().int().positive()}).parse(raw);
   try{
    if(!ctx.staffQuestionAnswer)throw Error("no_matching_pending_staff_question");
    const receipt=await ctx.staffQuestionAnswer(proposalId,revision);
    return {source:"staff_question_owner_report",period:null,agentId:"olivia",missing:[],
     saved:true,ownerReported:true,independentlyVerified:false,...receipt};
   }catch{return {source:"staff_question_owner_report",period:null,agentId:"olivia",
     missing:["owner_answer_not_recorded"],saved:false,ownerReported:false};}
  }
 }
} as const;
