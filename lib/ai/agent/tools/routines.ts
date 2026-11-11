import {z} from "zod";
import {routineScheduleSchema} from "@/lib/ai/supervisor/routines/contracts";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Strict nullable fields are required by the OpenAI function schema. */
export const manageRoutineSchema=z.strictObject({
  action:z.enum(["create","list","edit","pause","resume","revoke"]),
  routine_id:z.uuid().nullable(),
  revision:z.number().int().positive().nullable(),
  title:z.string().trim().min(1).max(240).nullable(),
  cadence:z.enum(["daily","weekly"]).nullable(),
  weekdays:z.array(z.number().int().min(1).max(7)).max(7).nullable(),
  local_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).nullable(),
});
function fullSchedule(input:z.infer<typeof manageRoutineSchema>){
  if(!input.title||!input.cadence||!input.weekdays||!input.local_time)
    throw new Error("Routine needs title, cadence, weekdays and local time");
  return routineScheduleSchema.parse({
    title:input.title,cadence:input.cadence,
    weekdays:input.weekdays,localTime:input.local_time,
  });
}
export const routineTools={
  manage_routine:{
    agentId:"leo" as const,
    schema:manageRoutineSchema,
    description:"Manage the owner's internally scheduled café check: create, list, edit, pause, resume or permanently revoke. A routine only evaluates already recorded café evidence and posts in-app priorities: it cannot spend money, message customers, change staffing/prices or start an autonomous agent. Use the current café-local clock and ask for the schedule when missing; daily takes weekdays=[]; weekly takes ISO weekdays 1=Monday to 7=Sunday. List saved routines before editing or pausing to get exact routine_id and revision. Editing requires all schedule fields. Revoke is irreversible. Never say a change was saved if the tool failed.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=manageRoutineSchema.parse(raw);
      const port=ctx.routines;
      const base={source:"supervisor_routines",period:null,agentId:"leo" as const};
      if(!port)return {...base,missing:["not_supported"]};
      if(input.action==="list"){
        return {...base,missing:[],routines:await port.list()};
      }
      if(input.action==="create"){
        return {...base,missing:[],routine:await port.create(fullSchedule(input))};
      }
      if(!input.routine_id||!input.revision)
        throw new Error("A saved routine ID and revision are required");
      const status=input.action==="pause"?"paused" as const:
        input.action==="resume"?"active" as const:
        input.action==="revoke"?"revoked" as const:undefined;
      const routine=await port.change({
        id:input.routine_id,revision:input.revision,
        ...(status?{status}:{}),
        ...(input.action==="edit"?{schedule:fullSchedule(input)}:{}),
      });
      return {...base,missing:[],routine};
    },
  },
} as const;
