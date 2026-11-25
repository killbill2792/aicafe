import {z} from "zod";
import {routineScheduleSchema} from "@/lib/ai/supervisor/routines/contracts";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Strict nullable fields are required by the OpenAI function schema. */
export const manageRoutineSchema=z.strictObject({
  action:z.enum(["create","list","list_goal_sources","edit","edit_goal","pause","resume","revoke"]),
  routine_id:z.uuid().nullable(),
  revision:z.number().int().positive().nullable(),
  title:z.string().trim().min(1).max(240).nullable(),
  cadence:z.enum(["once","daily","weekly"]).nullable(),
  /** Café-local date for a single due occurrence; null for daily/weekly. */
  once_local_date:z.iso.date().nullable().optional(),
  weekdays:z.array(z.number().int().min(1).max(7)).max(7).nullable(),
  local_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u).nullable(),
  /** Verified owner-message source, never model-authored objective prose. */
  goal_source_message_id:z.uuid().nullable(),
  /** Existing authenticated conversation pagination, never owner-supplied scope. */
  source_page_offset:z.number().int().min(0).max(10000).nullable(),
});
function fullSchedule(input:z.infer<typeof manageRoutineSchema>){
  if(!input.title||!input.cadence||!input.local_time)
    throw new Error("Routine needs a title, cadence and local time");
  return routineScheduleSchema.parse({
    title:input.title,cadence:input.cadence,
    weekdays:input.weekdays??[],localTime:input.local_time,
    ...(input.cadence==="once"?{onceLocalDate:input.once_local_date}:{}),
  });
}
export const routineTools={
  manage_routine:{
    agentId:"leo" as const,
    schema:manageRoutineSchema,
    description:"Manage an owner's saved natural-language café objective, once at a specified café-local date/time or on a recurring schedule: create, list, edit schedule, edit objective, pause, resume or permanently revoke. A newly created routine preserves the full actual owner message as its objective and, when the U4 runtime is enabled, uses the existing single Luna agent to research the objective with authorized café tools and post a concise verified report. Do not reduce the objective to the title. A legacy routine continues its existing priority check until edited or deliberately converted. A routine never grants authority to spend, message anyone, change staffing/prices or execute external effects. The saved routine ID, revision and status are authoritative. Use the current café-local clock and ask for the schedule when missing; once needs once_local_date (YYYY-MM-DD) and weekdays=[]; daily takes weekdays=[]; weekly takes ISO weekdays 1=Monday to 7=Sunday. Use manage_commitment only for a simple reminder, never for a requested future investigation. Resolve relative due times from the trusted café-local clock; never invent the owner’s full goal. List saved routines before editing or pausing to get exact routine_id and revision. For create, select goal_source_message_id from the authenticated owner-message IDs in this turn’s verified candidate list. When the original objective is not in the initial previews, use list_goal_sources with source_page_offset=0, then continue using the returned next_offset. Its scoped owner-only candidates are short previews: the database saves the entire original message. Select the ORIGINAL investigation request when a later owner reply only supplies a schedule; never substitute that clarification. Choose the current message ID for a single-turn complete request. Do not invent IDs; a missing source must be clarified rather than silently replaced with a scheduling response. Use edit_goal to update the owner objective from the actual authenticated owner message without restating the schedule; optional full schedule if both change. Use edit only for schedule changes with all fields, never to overwrite the goal. Revoke is irreversible. Never say a change was saved if the tool failed.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=manageRoutineSchema.parse(raw);
      const port=ctx.routines;
      const base={source:"supervisor_routines",period:null,agentId:"leo" as const};
      if(!port)return {...base,missing:["not_supported"]};
      if(input.action==="list"){
        return {...base,missing:[],routines:await port.list()};
      }
      if(input.action==="list_goal_sources"){
        if(!port.goalSources)return {...base,missing:["not_supported"]};
        const page=await port.goalSources(input.source_page_offset??0);
        return {...base,missing:[],sources:page.sources,next_offset:page.nextOffset};
      }
      if(input.action==="create"){
        const schedule=fullSchedule(input);
        // The owner approves first: nothing is saved until they tap Save on the card.
        if(port.draft)return {...base,missing:[],draft:true,saved:false,
          routineDraft:{...schedule,...port.draft(schedule,input.goal_source_message_id)}};
        return {...base,missing:[],routine:await port.create(schedule,input.goal_source_message_id)};
      }
      if(!input.routine_id||!input.revision)
        throw new Error("A saved routine ID and revision are required");
      if(input.action==="edit_goal"){
        const supplied=[input.title,input.cadence,input.weekdays,input.local_time,input.once_local_date]
          .filter(value=>value!==null&&value!==undefined);
        if(supplied.length&&supplied.length!==4&&supplied.length!==5)
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
          ...(input.title&&input.cadence&&input.local_time&&
            (input.cadence!=="once"||input.once_local_date)?
            {schedule:fullSchedule(input)}:{})}:{}),
      });
      return {...base,missing:[],routine};
    },
  },
} as const;

const {$schema:_routineToolSchema,...routineParameters}=z.toJSONSchema(manageRoutineSchema,{target:"draft-07"});
void _routineToolSchema;
// Match the registered tool registry's provider-wire hygiene: a standard ISO
// date format makes Zod's generated leap-year regex redundant. This owner-only
// extra tool bypasses the shared registry normalizer; keep runtime Zod strict.
const onceDateAlternatives=(routineParameters.properties as
  Record<string,{anyOf?:Array<Record<string,unknown>>}>|undefined)?.once_local_date?.anyOf;
for(const alternative of onceDateAlternatives??[]){
  if(alternative.type==="string"&&alternative.format==="date")delete alternative.pattern;
}
/** Advertised only on a server-verified owner thread via extraTools; unlike
 * global definitions, it cannot be offered by a caller without the owner port. */
export const routineToolDefinition={
  type:"function" as const,name:"manage_routine",
  description:routineTools.manage_routine.description,strict:true as const,
  parameters:{...routineParameters,required:Object.keys(routineParameters.properties??{})},
};
