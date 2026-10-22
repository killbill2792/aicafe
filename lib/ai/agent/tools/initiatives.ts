import "server-only";
import {createHash} from "node:crypto";
import { z } from "zod";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { proposeInitiativeSchema,initiativeStatusSchema } from "@/lib/initiatives/contracts";
import { metricKeySchema,metricCatalog } from "@/lib/calc/metrics/catalog";
import { createOwnerInitiative,listOwnerInitiatives,readOwnerInitiative,saveOwnerCheckin }
  from "@/lib/data/initiatives.server";
import type { AgentToolContext,AgentToolResult } from "./index";

// All model-facing objects are CLOSED with all keys required, including nested
// metric params. Flexible change_spec is a JSON string validated after decoding.
// Never weaken strict:true or expose the service-role database to the model.
const toolParams=z.strictObject({
  itemId:z.uuid().nullable(),
  ingredientId:z.uuid().nullable(),
  fromHour:z.number().int().min(0).max(23).nullable(),
  toHour:z.number().int().min(1).max(24).nullable(),
});
const toolMetric=z.strictObject({
  role:z.enum(["primary","guardrail"]),
  source:z.enum(["computed","checkin"]),
  metricKey:metricKeySchema.nullable(),
  params:toolParams,
  comparator:z.enum(["gte","lte"]),
  targetKind:z.enum(["absolute","relative_pct"]),
  target:z.number().finite(),
  checkinQuestion:z.string().min(1).max(300).nullable(),
  checkinAudience:z.enum(["owner","staff"]).nullable(),
  dataGap:z.string().max(300).nullable(),
});
const proposalArgs=z.strictObject({
  kind:z.enum(["goal","experiment"]),
  title:z.string().trim().min(1).max(160),
  changeDescription:z.string().max(1000),
  changeSpecJson:z.string().max(4000),
  adapterId:z.string().max(80).nullable(),
  startsOn:z.iso.date(),
  endsOn:z.iso.date(),
  baselineFrom:z.iso.date(),
  baselineTo:z.iso.date().nullable(),
  checkinCadence:z.enum(["daily","every_3_days","weekly","end_only"]),
  metrics:z.array(toolMetric).min(1).max(12),
});
const listArgs=z.strictObject({status:initiativeStatusSchema.nullable()});
const statusArgs=z.strictObject({id:z.uuid()});
const checkinArgs=z.strictObject({
  metricId:z.uuid(),date:z.iso.date(),value:z.number().finite().nullable(),
  note:z.string().trim().min(1).max(1000).nullable(),
}).refine(v=>v.value!==null||v.note!==null,"A value or note is required");
export const initiativeToolSchemas={
  propose_initiative:proposalArgs,
  get_initiatives:listArgs,
  get_initiative_status:statusArgs,
  record_checkin:checkinArgs,
} as const;
const descriptions={
  propose_initiative:"Create an INERT goal/experiment proposal. Write an object as changeSpecJson. Use checkin with a question and gap for noncatalog measurements. Owner approves separately.",
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
function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonicalJson).join(",")+"]";
  if(value!==null&&typeof value==="object")
    return "{"+Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
      .map(([key,item])=>JSON.stringify(key)+":"+canonicalJson(item)).join(",")+"}";
  return JSON.stringify(value);
}
function parseChangeSpec(json:string):Record<string,unknown> {
  try{
    const result:unknown=JSON.parse(json);
    if(result!==null&&typeof result==="object"&&!Array.isArray(result))
      return result as Record<string,unknown>;
  }catch {/* no private model input in logs */}
  throw new Error("initiative change spec must be a JSON object");
}
export async function executeInitiativeTool(
  name:keyof typeof initiativeToolSchemas,raw:unknown,ctx:AgentToolContext,
):Promise<AgentToolResult>{
  const {scope}=await authenticatedConversationContext();
  if(name==="propose_initiative"){
    if(!ctx.threadId)throw new Error("initiative thread context unavailable");
    const args=proposalArgs.parse(raw);
    const input=proposeInitiativeSchema.parse({
      threadId:ctx.threadId,kind:args.kind,title:args.title,
      changeDescription:args.changeDescription,
      changeSpec:parseChangeSpec(args.changeSpecJson),
      adapterId:args.adapterId,startsOn:args.startsOn,endsOn:args.endsOn,
      baselineFrom:args.baselineFrom,baselineTo:args.baselineTo,
      checkinCadence:args.checkinCadence,
      metrics:args.metrics.map(m=>{
        let params:Record<string,unknown>={};
        if(m.source==="computed"){
          if(m.metricKey==="item_units"||m.metricKey==="item_revenue"||m.metricKey==="item_margin")
            params={itemId:m.params.itemId};
          else if(m.metricKey==="ingredient_unit_cost")
            params={ingredientId:m.params.ingredientId};
          else if(m.metricKey==="sales_per_labor_hour")
            params={fromHour:m.params.fromHour,toHour:m.params.toHour};
        }
        return {...m,params};
      }),
    });
    if(!ctx.ownerMessageId)throw new Error("initiative owner message context unavailable");
    const requestKey=createHash("sha256").update(ctx.ownerMessageId+":"+canonicalJson(input)).digest("hex");
    const created=await createOwnerInitiative(scope,input,ctx.locale,requestKey);
    return {source:"owner_initiatives",period:null,missing:[],
      id:created.id,status:"proposed",kind:created.kind,title:created.title,
      metrics:(await readOwnerInitiative(scope,created.id))?.metrics.map(m=>({id:m.id,
        source:m.source,role:m.role,metricKey:m.metric_key,
        unit:m.metric_key?metricCatalog[m.metric_key].unit:null,
        question:m.checkin_question,target:m.target})),
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
    const unresolved=graph.metrics.filter(m=>{
      const result=graph.evaluation?.results[m.id];
      if(!result||typeof result!=="object"||!("coverage" in result))return true;
      return typeof result.coverage!=="number"||result.coverage<0.8;
    });
    return {source:"owner_initiatives",period:null,
      missing:graph.evaluation?.status==="insufficient_data"?
        (unresolved.length?unresolved.map(m=>m.metric_key??m.data_gap??"checkinPending"):["insufficientEvidence"]):
        (!graph.evaluation?["evaluationPending"]:[]),
      metrics:graph.metrics.slice(0,12).map(m=>({id:m.id,role:m.role,source:m.source,
        metricKey:m.metric_key,unit:m.metric_key?metricCatalog[m.metric_key].unit:null,
        comparator:m.comparator,targetKind:m.target_kind,target:m.target,
        question:m.checkin_question,audience:m.checkin_audience,dataGap:m.data_gap})),
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
  const saved=await saveOwnerCheckin(scope,args.metricId,args.date,args.value,args.note);
  return {source:"owner_checkin",period:null,
    missing:args.value===null?["checkinNumericValueMissing"]:[],
    created:saved.created,corrected:saved.corrected};
}
