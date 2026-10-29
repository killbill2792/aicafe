import {z} from "zod";
import {randomUUID} from "node:crypto";
import {catalogForMissing} from "@/lib/ownerFacts/catalog";
import {ownerFactLabel} from "@/lib/ownerFacts/questions";
import type {AgentToolContext,AgentToolResult} from "./index";
export const askOwnerSchema=z.strictObject({
 question:z.string().trim().min(1).max(200),
 kind:z.enum(["choice","fill","facts"]).optional(),
 options:z.array(z.strictObject({label:z.string().trim().min(1).max(60),
   value:z.string().trim().min(1).max(100)})).max(12),
 allowOther:z.boolean(),
 fields:z.array(z.strictObject({
   key:z.string().min(1).max(90),label:z.string().trim().min(1).max(100),
   inputType:z.enum(["number","money","percent","text","date","choice"]),
   units:z.array(z.string().min(1).max(20)).max(8),
   defaultUnit:z.string().max(20),
   choices:z.array(z.strictObject({label:z.string().trim().min(1).max(80),value:z.string().min(1).max(100)})).max(12).nullable().optional(),
 })).max(6).optional(),
}).superRefine((input,ctx)=>{
 // Choice-mode contracts remain strict while fill-mode accepts no choices.
 if(input.kind!=="fill"&&input.kind!=="facts"&&input.options.length<2)
  ctx.addIssue({code:"custom",message:"Choose between two and four options"});
});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const askOwnerTools={ask_owner:{
 agentId:"alex",schema:askOwnerSchema,
 description:"Ask once each turn when any needed fact is missing, unknown, empty or failed. For arbitrary questions use kind=facts with 1–6 number, money, percent, text, date or choice fields; options=[] and allowOther=false. Use a generic text field when the key is unknown. For known ambiguity use verified kind=choice candidates. Legacy pantry counts use verified kind=fill only. Never ask for a figure already returned or saved.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const input=askOwnerSchema.parse(raw);
  const state=ctx.resolveState;
  if(!state||state.asked)return {source:"ask_owner",period:null,missing:["alreadyAsked"],error:"askOwnerLimit"};
  if(input.kind==="facts"){
    if(!input.fields?.length||input.options.length||input.allowOther||input.fields.length>6||
      new Set(input.fields.map(f=>f.key)).size!==input.fields.length||
      input.fields.some(f=>f.inputType==="choice"&&(!f.choices||f.choices.length<2)))
      return {source:"ask_owner",period:null,missing:["invalidFields"],error:"invalidFactFields"};
    const fields=input.fields.map(field=>{
      const entry=catalogForMissing(field.key);
      if(entry.labelKey!=="generic"&&entry.type!==field.inputType)return null;
      // Reject unscoped model cards before marking the turn as asked.
      // This allows the agent to recover with an item-specific question.
      if(entry.factKey==="unit_cost_cents")return null;
      return {...field,key:entry.factKey,
        label:entry.labelKey!=="generic"?ownerFactLabel(entry.factKey,entry.labelKey,ctx.locale):field.label};
    });
    if(fields.some(field=>field===null)||new Set(fields.map(field=>field?.key)).size!==fields.length)
      return {source:"ask_owner",period:null,missing:["invalidFields"],error:"invalidFactFields"};
    state.asked=true;
    return {source:"ask_owner",period:null,missing:[],kind:"facts",
      questionId:randomUUID(),question:input.question,fields:fields.filter(f=>f!==null)};
  }
  if(input.kind==="fill"){
    if(!input.fields?.length||input.options.length||input.allowOther||input.fields.some(f=>f.inputType!=="number"))
      return {source:"ask_owner",period:null,missing:["invalidFields"],error:"invalidFillFields"};
    const verified=input.fields!.every(field=>{
      const observed=state.usageMissing.get(field.key);
      return observed&&field.label.toLocaleLowerCase().includes(observed.name.toLocaleLowerCase())&&
        field.units.includes(field.defaultUnit)&&field.units.includes(observed.unit);
    });
    if(!verified)return {source:"ask_owner",period:null,missing:["noMissingInput"],error:"unverifiedFillField"};
    state.asked=true;
    return {source:"ask_owner",period:null,missing:[],kind:"fill",question:input.question,fields:input.fields};
  }
  if(input.fields?.length)return {source:"ask_owner",period:null,missing:["invalidChoiceFields"],error:"invalidChoiceFields"};
  if(input.options.length<2||!state.ambiguous.length)return {source:"ask_owner",period:null,missing:["noAmbiguity"],error:"noRecordedAmbiguity"};
  if(new Set(input.options.map(o=>o.label.trim().toLocaleLowerCase())).size!==input.options.length)
    return {source:"ask_owner",period:null,missing:["duplicateLabels"],error:"duplicateLabels"};
  if(input.options.some(o=>uuid.test(o.value)&&!state.seenIds.has(o.value.toLowerCase())))
    return {source:"ask_owner",period:null,missing:["inventedOptionId"],error:"unverifiedOptionId"};
  // Every displayed (label, value) pair must come from one single tool group;
  // a correct UUID with a spoofed label can otherwise mislead an owner.
  const exact=state.ambiguous.some(group=>input.options.every(o=>
    group.some(candidate=>candidate.id===o.value&&(candidate.label===o.label||o.label.startsWith(candidate.label)||candidate.label.startsWith(o.label+" — ")||candidate.label.startsWith(o.label+" (")))));
  if(!exact)return {source:"ask_owner",period:null,missing:["unverifiedOption"],error:"notFromTool"};
  state.asked=true;
  return {source:"ask_owner",period:null,missing:[],kind:"choice",question:input.question,options:input.options,allowOther:input.allowOther};
 }
}} as const;
