import type {AgentToolContext,AgentToolResult} from "@/lib/ai/agent/tools";
import type {MilkSize} from "./milkSwap";
import {requestedMilkSizes} from "./milkSwap";
import {savedValue,type SavedFact} from "./inject";

type MilkReadContext=AgentToolContext & {savedOwnerFacts?:readonly SavedFact[]};
export type MilkSwapInputs={sizes:MilkSize[];results:AgentToolResult[];missing:string[]};
/**
 * Single café-scoped read boundary for milk swap. D can replace only the
 * implementation with the canonical reader without changing the tool contract.
 * No cross-café identifiers or mutable POS requests are accepted.
 */
export async function readMilkSwapInputs(
 ctx:MilkReadContext,targetMilk:string,baseMilk:string|null,sizes:readonly string[]
):Promise<MilkSwapInputs>{
 const missing:string[]=[];
 const facts=ctx.savedOwnerFacts??[];
 const selectedBase=baseMilk?.trim()||
  (typeof savedValue(facts,"milk_base_type")==="string"?
   String(savedValue(facts,"milk_base_type")).trim():"");
 const selectedTarget=targetMilk.trim()||
  (typeof savedValue(facts,"milk_target_type")==="string"?
   String(savedValue(facts,"milk_target_type")).trim():"");
 let availableSizes:MilkSize[]=[];
 const results:AgentToolResult[]=[];
 try{
  const catalog=await ctx.tools.getMenuCatalog();
  if(catalog.available){
   const active=catalog.value.filter(item=>item.active);
   availableSizes=[...new Map(active.flatMap(item=>
    requestedMilkSizes(item.name).map(size=>[size.id,size] as const))).values()];
   // Keep recorded size/volume evidence when the catalogue supports it.
   results.push({source:"menu_catalog",period:null,missing:[],items:active});
  }else if(!sizes.length)missing.push(...catalog.quality.missingInputs);
 }catch{
  if(!sizes.length)missing.push("menuReadFailed");
 }
 const requested=sizes.length?sizes.flatMap(value=>requestedMilkSizes(value)):[];
 const savedSize=savedValue(facts,"milk_requested_size");
 const remembered=!sizes.length&&typeof savedSize==="string"?
  requestedMilkSizes(savedSize):[];
 const selected=[...new Map((requested.length?requested:
  availableSizes.length?availableSizes:remembered).map(size=>[size.id,size] as const)).values()];
 if(!selected.length)missing.push("milk_requested_size");
 if(ctx.tools.getIngredientCosts){
  const names=[...new Set([selectedBase,selectedTarget].filter(Boolean))];
  const reads=await Promise.all(names.map(async name=>{
   try{
    const slice=await ctx.tools.getIngredientCosts!(ctx.asOf,name,10);
    return {items:slice.available?slice.value.items:[],
     missing:slice.quality.missingInputs,
     error:!slice.available};
   }catch{return {items:[],missing:["ingredientReadFailed"],error:true};}
  }));
  if(reads.length)results.push({source:"ingredient_prices",period:null,
   items:reads.flatMap(read=>read.items),
   missing:[...new Set(reads.flatMap(read=>read.missing))],
   ...(reads.some(read=>read.error)?{error:"ingredient_read_failed"}:{})});
 }
 return {sizes:selected,results,missing:[...new Set(missing)]};
}
