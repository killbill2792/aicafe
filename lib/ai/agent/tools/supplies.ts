import { z } from "zod";
import {projectUsageTool} from "@/lib/calc/usageToolProjection";
import type { AgentToolContext, AgentToolResult } from "./index";
import {resolveEntity,choicePayload} from "../resolve";

const item=z.strictObject({itemId:z.uuid()});
const ingredients=z.strictObject({query:z.string().max(80).nullable(),limit:z.number().int().min(1).max(20).nullable()});
const empty=z.strictObject({});
const usage=z.strictObject({from:z.string(),to:z.string(),ingredient:z.string().nullable(),group_by:z.enum(["shift","day","staff"]).nullable()});
export const suppliesTools={
 get_usage_variance:{
  agentId:"maya",schema:usage,description:"Read recipe-based expected ingredient use and counted actual use for inclusive dates. Shift/staff groups represent expected usage only.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=usage.parse(raw);
   if(!ctx.tools.getUsageVariance)return {source:"usage_variance",period:{from:input.from,to:input.to},agentId:"maya",missing:["usageReaderUnavailable"],rows:null};
   const result=await ctx.tools.getUsageVariance({from:input.from,to:input.to,ingredient:input.ingredient,groupBy:input.group_by});
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
        const choice=resolveEntity("product",found.name,menu.value.filter(row=>row.active),{
          nameOf:r=>r.name,idOf:r=>r.id,describe:r=>r.category+" · "+(r.priceCents/100).toFixed(2)});
        if(choice.status==="ambiguous"&&!ctx.resolveState.chosenIds.has(itemId.toLowerCase()))
          return {...choicePayload(choice,"product_costs",null),agentId:"maya"};
      }
      if(!ctx.tools.getProductEconomics)return {source:"product_costs",period:null,agentId:"maya",missing:["productCostReaderUnavailable"]};
      const s=await ctx.tools.getProductEconomics(itemId);
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
      const s=await ctx.tools.getIngredientCosts(ctx.asOf,query,limit??12);
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
  get_inventory:{
    agentId:"maya",schema:empty,description:"Inventory quantities are not tracked; always report that limitation.",
    execute:async(raw:unknown):Promise<AgentToolResult>=>{
      empty.parse(raw);
      return {source:"inventory",period:null,agentId:"maya",missing:["inventoryNotTracked"],inventory:null};
    },
  },
} as const;
