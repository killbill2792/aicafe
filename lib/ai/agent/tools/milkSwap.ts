import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {milkSwapFromFacts} from "@/lib/ownerFacts/milkSwap";
import {readMilkSwapInputs} from "@/lib/ownerFacts/milkSwapInputs";
import type {SavedFact} from "@/lib/ownerFacts/inject";

const schema=z.strictObject({
 targetMilk:z.string().trim().max(120),
 baseMilk:z.string().trim().min(1).max(120).nullable(),
 sizes:z.array(z.string().trim().min(1).max(60)).max(12),
});
type ScopedContext=AgentToolContext & {savedOwnerFacts?:readonly SavedFact[]};
export const milkSwapTools={milk_swap_price:{
 agentId:"alex" as const,
 schema,
 description:"Estimate a milk substitution upcharge per menu size using saved café facts and the shared modifier pricing calculator. targetMilk is the requested type (empty string if unknown), baseMilk is the known current type or null, sizes are explicitly requested names such as '16 oz' (empty array = all recorded menu sizes). Never assume oat or invent size/volume/cost. Use the returned ISO currency when writing prices. If missing lists any facts, call ask_owner with the typed fields, then calculate again after the answer is saved. Answer other parts of combined questions too.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const input=schema.parse(raw);
  const scoped=ctx as ScopedContext;
  const read=await readMilkSwapInputs(scoped,input.targetMilk,input.baseMilk,input.sizes);
  const answer=milkSwapFromFacts(read.sizes,scoped.savedOwnerFacts??[],read.results,
   input.targetMilk,input.baseMilk);
  return {...answer,source:"milk_swap",currency:ctx.currency??null,missing:[...new Set([...answer.missing,...read.missing])],
   readSources:read.results.map(row=>({source:row.source,missing:row.missing,
    ...(row.error?{error:row.error}:{})}))};
 }
}} as const;
