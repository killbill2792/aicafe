import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** One chat capability for creating, listing and closing the SAME persisted task. */
export const commitmentSchema=z.strictObject({
  action:z.enum(["create","list","close"]),
  title:z.string().max(240).nullable(),
  due_date:z.iso.date().nullable(),
  due_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).nullable(),
  origin:z.enum(["owner_chat","supervisor_followup"]).nullable(),
  commitment_id:z.string().max(160).nullable(),
});

export const commitmentTools={
  manage_commitment:{
    agentId:"leo",schema:commitmentSchema,
    description:"Create a durable owner reminder or promised follow-up, list saved commitments, or close one. For 'remind me Tuesday' resolve Tuesday to an ISO café-local date using the provided café date and timezone; a missing clock time is null (due at start of that local day). Do not pretend a reminder was saved unless this tool succeeds. For close, list first to get the actual id. Never recreate a closed item.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=commitmentSchema.parse(raw);
      // Server-injected verified owner port; never reauthenticates with cookies.
      const service=ctx.commitments;
      if(!service)return {source:"operating_tasks",period:null,agentId:"leo",missing:["not_supported"]};
      if(input.action==="list"){
        const commitments=await service.list();
        return {source:"operating_tasks",period:null,agentId:"leo",missing:[],commitments};
      }
      if(input.action==="close"){
        if(!input.commitment_id)throw new Error("A saved commitment ID is required to close it");
        const closed=await service.close(input.commitment_id);
        return {source:"operating_tasks",period:null,agentId:"leo",
          missing:closed?[]:["commitmentNotFound"],closed,commitmentId:input.commitment_id};
      }
      if(!ctx.threadId)throw new Error("The authenticated chat thread is required");
      if(!input.title||!input.due_date)throw new Error("A title and due date are required");
      const commitment=await service.create({
        title:input.title,dueDate:input.due_date,
        dueTime:input.due_time,origin:input.origin??"owner_chat",
      });
      return {source:"operating_tasks",period:null,agentId:"leo",missing:[],
        saved:true,commitment};
    },
  },
} as const;
