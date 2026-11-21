import {staffQuestionInput} from "@/lib/staffCommunication/ownerQuestion.contract";
import type {AgentToolContext,AgentToolResult} from "./index";
/** Source-grounded proposal only; the existing effect gateway owns every send. */
export const staffQuestionTools={
 propose_staff_question:{
  agentId:"olivia" as const,schema:staffQuestionInput,
  description:"After reading the actual café evidence and current published schedule, propose asking one linked employee who is scheduled on-shift a narrow factual question. Pass the exact alert or operating-task source type/ID, source/as-of evidence and a future follow-up time. The owner will choose Ask, Answer myself, or Ignore. This tool NEVER sends an employee message or updates stock/roster; unknown facts stay unknown.",
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
 }
} as const;
