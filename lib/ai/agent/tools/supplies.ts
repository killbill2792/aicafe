import { z } from "zod";
import {projectUsageTool} from "@/lib/calc/usageToolProjection";
import type { AgentToolContext, AgentToolResult } from "./index";
import {resolveEntity,choicePayload,ownerNamedTarget} from "../resolve";
import {dataQueryTools} from "./dataQuery";

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
        if(!ownerNamedTarget(ctx.resolveState,itemId,found.name))
          return {source:"product_costs",period:null,agentId:"maya",missing:["targetNotConfirmed"]};
        const choice=resolveEntity("product",found.name,menu.value.filter(row=>row.active),{
          nameOf:r=>r.name,idOf:r=>r.id,describe:r=>r.category+" · "+(r.priceCents===null?"open price":(r.priceCents/100).toFixed(2))});
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
    agentId:"maya",schema:empty,description:"Read café-scoped dated inventory counts and Toast menu-item stock through the existing canonical reader. Never infer that an omitted Toast item has zero stock, or that a stale count is current.",
    execute:async(raw:unknown,ctx?:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx?.canonicalData||!ctx.timezone)
        return {source:"inventory",period:null,agentId:"maya",
          missing:["inventoryNotTracked"],inventory:null};
      try{
        // The signed-in café's timezone, never a UTC day or model-supplied date.
        const date=ctx.asOf.includes("T")?
          new Intl.DateTimeFormat("en-CA",{timeZone:ctx.timezone,year:"numeric",
            month:"2-digit",day:"2-digit"}).format(new Date(ctx.asOf)):
          ctx.asOf.slice(0,10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("invalid date");
        const scoped=await ctx.canonicalData();
        const result=await dataQueryTools.query_data.execute({
          view:"cv_inventory",columns:["source","source_ref","status","business_date",
            "menu_item_ref","stock_status","quantity","data"],
          filters:null,group_by:null,metrics:null,date_from:date,date_to:date,
          order_by:null,limit:50},scoped);
        const missing=result.missing??[];
        return {source:"inventory",period:{from:date,to:date},agentId:"maya",
          missing,inventory:result.empty?null:result.rows,
          sourceMix:result.sourceMix,truncated:result.truncated,
          // No implied complete inventory: Toast GET excludes IN_STOCK items.
          scope:"observed_inventory_only",quantitySemantics:"no_unobserved_zero"};
      }catch{
        return {source:"inventory",period:null,agentId:"maya",
          missing:["inventoryReaderUnavailable"],inventory:null};
      }
    },
  },
} as const;
