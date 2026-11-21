import {z} from "zod";
import {routineScheduleSchema} from "@/lib/ai/supervisor/routines/contracts";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Strict nullable fields are required by the OpenAI function schema. */
export const manageRoutineSchema=z.strictObject({
  action:z.enum(["create","list","edit","edit_goal","pause","resume","revoke"]),
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
    description:"Manage an owner's saved natural-language recurring café objective: create, list, edit schedule, edit objective, pause, resume or permanently revoke. A newly created routine preserves the full actual owner message as its objective and, when the U4 runtime is enabled, uses the existing single Luna agent to research the objective with authorized café tools and post a concise verified report. Do not reduce the objective to the title. A legacy routine continues its existing priority check until edited or deliberately converted. A routine never grants authority to spend, message anyone, change staffing/prices or execute external effects. The saved routine ID, revision and status are authoritative. Use the current café-local clock and ask for the schedule when missing; daily takes weekdays=[]; weekly takes ISO weekdays 1=Monday to 7=Sunday. List saved routines before editing or pausing to get exact routine_id and revision. Use edit_goal to update the owner objective from the actual authenticated owner message without restating the schedule; optional full schedule if both change. Use edit only for schedule changes with all fields, never to overwrite the goal. Revoke is irreversible. Never say a change was saved if the tool failed.",
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
      if(input.action==="edit_goal"){
        const supplied=[input.title,input.cadence,input.weekdays,input.local_time]
          .filter(value=>value!==null);
        if(supplied.length&&supplied.length!==4)
          throw new Error("Changing the objective and schedule together requires all schedule fields; partial changes cannot be silently ignored");
      }
      const status=input.action==="pause"?"paused" as const:
        input.action==="resume"?"active" as const:
        input.action==="revoke"?"revoked" as const:undefined;
      const routine=await port.change({
        id:input.routine_id,revision:input.revision,
        ...(status?{status}:{}),
        ...(input.action==="edit"?{schedule:fullSchedule(input)}:{}),
        ...(input.action==="edit_goal"?{objectiveEdit:true,
          ...(input.title&&input.cadence&&input.weekdays&&input.local_time?
            {schedule:fullSchedule(input)}:{})}:{}),
      });
      return {...base,missing:[],routine};
    },
  },
} as const;

const {$schema:_routineToolSchema,...routineParameters}=z.toJSONSchema(manageRoutineSchema,{target:"draft-07"});
void _routineToolSchema;
/** Advertised only on a server-verified owner thread via extraTools; unlike
 * global definitions, it cannot be offered by a caller without the owner port. */
export const routineToolDefinition={
  type:"function" as const,name:"manage_routine",
  description:routineTools.manage_routine.description,strict:true as const,
  parameters:{...routineParameters,required:Object.keys(routineParameters.properties??{})},
};
