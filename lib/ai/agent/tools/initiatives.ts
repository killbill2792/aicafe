import "server-only";
import { z } from "zod";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { proposeInitiativeSchema, initiativeMetricSchema,initiativeStatusSchema }
  from "@/lib/initiatives/contracts";
import { createOwnerInitiative,listOwnerInitiatives,readOwnerInitiative,saveOwnerCheckin }
  from "@/lib/data/initiatives.server";
import type { AgentToolContext,AgentToolResult } from "./index";

const proposalArgs=proposeInitiativeSchema.safeExtend({
  // The thread comes only from the server's authenticated agent route, never the model.
}).omit({threadId:true});
const listArgs=z.strictObject({status:initiativeStatusSchema.nullable()});
const statusArgs=z.strictObject({id:z.uuid()});
const checkinArgs=z.strictObject({
  metricId:z.uuid(),value:z.number().finite().nullable(),note:z.string().trim().min(1).max(1000).nullable(),
}).refine(v=>v.value!==null||v.note!==null,"A value or note is required");
export const initiativeToolSchemas={
  propose_initiative:proposalArgs,
  get_initiatives:listArgs,
  get_initiative_status:statusArgs,
  record_checkin:checkinArgs,
} as const;
const descriptions={
  propose_initiative:"Create an INERT goal/experiment proposal. Owner must approve it separately; no café changes happen.",
  get_initiatives:"Read this owner's recent goals and experiments.",
  get_initiative_status:"Read a goal/experiment and its latest evidence, gaps and evaluation.",
  record_checkin:"Record an owner's check-in for a check-in metric. This never applies a change.",
};
export const initiativeToolDefinitions=Object.entries(initiativeToolSchemas).map(([name,schema])=>{
  const {$schema:_schema,...parameters}=z.toJSONSchema(schema,{target:"draft-07"});
  void _schema;
  return {type:"function" as const,name,description:descriptions[name as keyof typeof descriptions],
    strict:true as const,parameters};
});
export function isInitiativeTool(name:string):name is keyof typeof initiativeToolSchemas {
  return Object.hasOwn(initiativeToolSchemas,name);
}
export async function executeInitiativeTool(
  name:keyof typeof initiativeToolSchemas,raw:unknown,ctx:AgentToolContext,
):Promise<AgentToolResult>{
  const {scope}=await authenticatedConversationContext();
  if(name==="propose_initiative"){
    if(!ctx.threadId)throw new Error("initiative thread context unavailable");
    const parsed=proposalArgs.parse(raw);
    // Validate against the complete canonical schema, including windows and provenance.
    const input=proposeInitiativeSchema.parse({...parsed,threadId:ctx.threadId});
    const created=await createOwnerInitiative(scope,input,ctx.locale);
    return {source:"owner_initiatives",period:null,missing:[],
      id:created.id,status:"proposed",kind:created.kind,title:created.title,
      display:{type:"approval_card",id:created.id,revision:created.revision,
        endpoint:"/api/ai/initiatives/"+created.id+"/approve",
        title:created.title,summary:created.change_description,requiresOwnerApproval:true}};
  }
  if(name==="get_initiatives"){
    const input=listArgs.parse(raw);
    const items=await listOwnerInitiatives(scope,input.status??undefined);
    return {source:"owner_initiatives",period:null,missing:[],
      items:items.map(i=>({id:i.id,title:i.title,kind:i.kind,status:i.status,
        startsOn:i.starts_on,endsOn:i.ends_on}))};
  }
  if(name==="get_initiative_status"){
    const {id}=statusArgs.parse(raw);
    const graph=await readOwnerInitiative(scope,id);
    if(!graph)return {source:"owner_initiatives",period:null,missing:["initiativeUnavailable"]};
    return {source:"owner_initiatives",period:null,
      missing:graph.metrics.filter(m=>m.data_gap).map(m=>m.data_gap!),
      initiative:{id:graph.initiative.id,title:graph.initiative.title,status:graph.initiative.status,
        revision:graph.initiative.revision,startsOn:graph.initiative.starts_on,endsOn:graph.initiative.ends_on},
      evaluation:graph.evaluation?{status:graph.evaluation.status,
        recommendation:graph.evaluation.recommendation,asOf:graph.evaluation.as_of,
        results:graph.evaluation.results}:null,
      observations:graph.observations.slice(0,20).map(o=>({
        metricId:o.metric_id,date:o.business_date,value:o.value,coverage:o.coverage,source:o.source,
      }))};
  }
  const args=checkinArgs.parse(raw);
  const saved=await saveOwnerCheckin(scope,args.metricId,args.value,args.note);
  return {source:"owner_checkin",period:null,missing:[],created:saved.created};
}
