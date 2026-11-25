import {z} from "zod";
import {staffQuestionInput} from "@/lib/staffCommunication/ownerQuestion.contract";
import type {AgentToolContext,AgentToolResult} from "./index";
/** Source-grounded proposal only; the existing effect gateway owns every send. */
export const staffQuestionTools={
 propose_staff_question:{
  agentId:"olivia" as const,schema:staffQuestionInput,
  description:"Propose a message or question to one active, linked employee. When the owner asked you in chat to contact someone, use sourceKind owner_chat (the server binds the owner's message; sourceTaskId may be any text). Use alert or operating_task only when the message is about that record. The owner approves the card before anything is sent; this tool NEVER sends by itself. Provide source/as-of evidence (for owner_chat: the owner message) and a future follow-up time.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=staffQuestionInput.parse(raw);
   try{
    if(!ctx.staffQuestionPropose)throw new Error("staff_question_port_unavailable");
    const proposal=await ctx.staffQuestionPropose(input);
    return {source:"staff_question_proposal",period:null,agentId:"olivia",missing:[],
     draft:true,saved:false,requiredApproval:"owner_click",...proposal};
   }catch(error){
    // The server's own refusal codes (for example worker_not_on_current_published_shift) are safe, fixed
    // identifiers; pass them on so Supervisor can tell the owner exactly why and what else is possible.
    const code=error instanceof Error&&/^[a-z][a-z0-9_]{2,80}$/u.test(error.message)?error.message:null;
    return {source:"staff_question_proposal",period:null,agentId:"olivia",
     missing:["staff_question_source_or_worker_unavailable"],draft:false,saved:false,...(code?{reason:code}:{})};}
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
