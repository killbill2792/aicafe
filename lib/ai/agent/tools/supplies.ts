import { z } from "zod";
import {projectUsageTool} from "@/lib/calc/usageToolProjection";
import type { AgentToolContext, AgentToolResult } from "./index";
import {resolveEntity,choicePayload,ownerNamedTarget} from "../resolve";

const item=z.strictObject({itemId:z.uuid()});
const ingredients=z.strictObject({query:z.string().max(80).nullable(),limit:z.number().int().min(1).max(20).nullable()});
const usage=z.strictObject({from:z.string(),to:z.string(),ingredient:z.string().nullable(),group_by:z.enum(["shift","day","staff"]).nullable()});
export const suppliesTools={
 get_usage_variance:{
  agentId:"maya",schema:usage,description:"Read recipe-based expected ingredient use and counted actual use for inclusive dates. Shift/staff groups represent expected usage only.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=usage.parse(raw);
   if(!ctx.tools.getUsageVariance)return {source:"usage_variance",period:{from:input.from,to:input.to},agentId:"maya",missing:["usageReaderUnavailable"],rows:null};
   let result;
   try{
    result=await ctx.tools.getUsageVariance({
     from:input.from,to:input.to,ingredient:input.ingredient,groupBy:input.group_by
    });
   }catch(error){
    // This is an actual source-read failure, not a zero-waste observation.
    // Postgres 57014 gets a specific missing-data reason; never echo SQL/PII.
    const msg=error instanceof Error?error.message:"";
    const timeout=msg.includes("usage_source_timeout")||msg.includes("57014");
    return {source:"usage_variance",period:{from:input.from,to:input.to},
     agentId:"maya",missing:[timeout?"usageVarianceSourceTimeout":"usageVarianceReadFailed"],rows:null};
   }
   return projectUsageTool(result);
  }
 },
  get_product_costs:{
    agentId:"maya",schema:item,description:"Known current menu-item product/recipe costs, by menu item id.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {itemId}=item.parse(raw);
      if(ctx.resolveState){
        const menu=await ctx.tools.getMenuCatalog();
        if(!menu.available)return {source:"product_costs",period:null,agentId:"maya",
          missing:menu.quality.missingInputs.length?menu.quality.missingInputs:["menuReaderUnavailable"]};
        const found=menu.value.find(row=>row.active&&row.id===itemId);
        if(!found)return {source:"product_costs",period:null,agentId:"maya",missing:["notFound"]};
        if(!ownerNamedTarget(ctx.resolveState,itemId,found.name))
          return {source:"product_costs",period:null,agentId:"maya",missing:["targetNotConfirmed"]};
        const choice=resolveEntity("product",found.name,menu.value.filter(row=>row.active),{
          nameOf:r=>r.name,idOf:r=>r.id,describe:r=>r.category+" · "+(r.priceCents===null?"open price":(r.priceCents/100).toFixed(2))});
        if(choice.status==="ambiguous"&&!ctx.resolveState.chosenIds.has(itemId.toLowerCase()))
          return {...choicePayload(choice,"product_costs",null),agentId:"maya"};
      }
      if(!ctx.tools.getProductEconomics)return {source:"product_costs",period:null,agentId:"maya",missing:["productCostReaderUnavailable"]};
      const s=await ctx.tools.getProductEconomics(itemId).catch(()=>null);
      if(!s)return {source:"product_costs",period:null,agentId:"maya",
        missing:["productCostReadFailed"],item:null};
      if(!s.available)return {source:"product_costs",period:null,agentId:"maya",missing:s.quality.missingInputs};
      const v=s.value;
      return {source:"product_costs",period:null,agentId:"maya",missing:s.quality.missingInputs,
        item:{id:v.id,name:v.name,priceCents:v.priceCents,costStatus:v.costStatus,
          costSource:v.costSource??null,ingredientsCentsToday:v.costStatus==="READY"?v.ingredientsCentsToday:null,
          recipeCostCents:v.recipeCostCents??null,ownerTotalCostCents:v.ownerTotalCostCents??null,
          costQuality:v.costQuality??null}};
    },
  },
  get_ingredient_costs:{
    agentId:"maya",schema:ingredients,description:"Latest dated ingredient price per base unit; unpriced items stay unknown.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {query,limit}=ingredients.parse(raw);
      if(!ctx.tools.getIngredientCosts)return {source:"ingredient_prices",period:null,agentId:"maya",missing:["ingredientReaderUnavailable"]};
      const s=await ctx.tools.getIngredientCosts(ctx.asOf,query,limit??12).catch(()=>null);
      if(!s)return {source:"ingredient_prices",period:null,agentId:"maya",
        missing:["ingredientCostReadFailed"],items:null};
      if(!s.available)return {source:"ingredient_prices",period:null,agentId:"maya",
        missing:s.quality.missingInputs,items:null};
      let items=s.value.items;
      if(query){
        const found=resolveEntity("ingredient",query,items,{
          nameOf:i=>i.name,idOf:i=>i.id,describe:i=>i.baseUnit});
        if(found.status!=="resolved")return {...choicePayload(found,"ingredient_prices",null),agentId:"maya"};
        items=[found.value];
      }
      return {source:"ingredient_prices",period:null,agentId:"maya",
        missing:s.quality.missingInputs,items};
    },
  },

} as const;
