import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
export const askOwnerSchema=z.strictObject({
 question:z.string().trim().min(1).max(200),
 options:z.array(z.strictObject({label:z.string().trim().min(1).max(60),
   value:z.string().trim().min(1).max(100)})).min(2).max(4),
 allowOther:z.boolean(),
});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const askOwnerTools={ask_owner:{
 agentId:"alex",schema:askOwnerSchema,
 description:"Ask the owner at most once per turn. Use kind choice with 2–4 real options when a tool reported ambiguity. Use kind fill with number fields ONLY when the usage variance tool explicitly reported that exact ingredient's missing purchase or closing count. Every fill field key must be endCount:ingredientUUID:YYYY-MM-DD or purchase:ingredientUUID:YYYY-MM-DD from tool results. Never ask for values a tool can already read.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const input=askOwnerSchema.parse(raw);
  const state=ctx.resolveState;
  if(!state||state.asked)return {source:"ask_owner",period:null,missing:["alreadyAsked"],error:"askOwnerLimit"};
  if(input.kind==="fill"){
    if(!input.fields.length||input.options.length||input.allowOther)
      return {source:"ask_owner",period:null,missing:["invalidFields"],error:"invalidFillFields"};
    const verified=input.fields.every(field=>{
      const observed=state.usageMissing.get(field.key);
      return observed&&field.label.toLocaleLowerCase().includes(observed.name.toLocaleLowerCase())&&
        field.units.includes(field.defaultUnit)&&field.units.includes(observed.unit);
    });
    if(!verified)return {source:"ask_owner",period:null,missing:["noMissingInput"],error:"unverifiedFillField"};
    state.asked=true;
    return {source:"ask_owner",period:null,missing:[],kind:"fill",question:input.question,fields:input.fields};
  }
  if(input.options.length<2||!state.ambiguous.length)return {source:"ask_owner",period:null,missing:["noAmbiguity"],error:"noRecordedAmbiguity"};
  if(new Set(input.options.map(o=>o.label.trim().toLocaleLowerCase())).size!==input.options.length)
    return {source:"ask_owner",period:null,missing:["duplicateLabels"],error:"duplicateLabels"};
  if(input.options.some(o=>uuid.test(o.value)&&!state.seenIds.has(o.value.toLowerCase())))
    return {source:"ask_owner",period:null,missing:["inventedOptionId"],error:"unverifiedOptionId"};
  // Every displayed (label, value) pair must come from one single tool group;
  // a correct UUID with a spoofed label can otherwise mislead an owner.
  const exact=state.ambiguous.some(group=>input.options.every(o=>
    group.some(candidate=>candidate.id===o.value&&candidate.label===o.label)));
  if(!exact)return {source:"ask_owner",period:null,missing:["unverifiedOption"],error:"notFromTool"};
  state.asked=true;
  return {source:"ask_owner",period:null,missing:[],kind:"choice",question:input.question,options:input.options,allowOther:input.allowOther};
 }
}} as const;
