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
 description:"Ask the owner to choose ONLY when a needed decision is truly ambiguous (several matching items, people, categories or periods) and a wrong guess would change numbers or a proposal. Never ask for something a tool can read. Use 2–4 choices from actual tool results and stop.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const input=askOwnerSchema.parse(raw);
  const state=ctx.resolveState;
  if(!state||state.asked)return {source:"ask_owner",period:null,missing:["alreadyAsked"],error:"askOwnerLimit"};
  if(!state.ambiguous.length)return {source:"ask_owner",period:null,missing:["noAmbiguity"],error:"noRecordedAmbiguity"};
  if(new Set(input.options.map(o=>o.label.trim().toLocaleLowerCase())).size!==input.options.length)
    return {source:"ask_owner",period:null,missing:["duplicateLabels"],error:"duplicateLabels"};
  if(input.options.some(o=>uuid.test(o.value)&&!state.seenIds.has(o.value.toLowerCase())))
    return {source:"ask_owner",period:null,missing:["inventedOptionId"],error:"unverifiedOptionId"};
  if(state.ambiguous.length&&!input.options.every(o=>
    state.ambiguous.some(group=>group.some(candidate=>candidate.id===o.value||candidate.label===o.label))))
    return {source:"ask_owner",period:null,missing:["unverifiedOption"],error:"notFromTool"};
  state.asked=true;
  return {source:"ask_owner",period:null,missing:[],question:input.question,options:input.options,allowOther:input.allowOther};
 }
}} as const;
