import { z } from "zod";
import {resolvePeriod} from "@/lib/calc/periods";
import {resolveEntity,choicePayload,periodChoicePayload} from "../resolve";
import type { AgentToolContext, AgentToolResult } from "./index";

const period=z.strictObject({period:z.union([z.enum(["today","week","month","last_week","last_month","ytd"]),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})])});
const item=z.strictObject({itemId:z.uuid()});
export const salesTools={
  get_item_sales:{
    agentId:"alex",schema:period,description:"Covered item quantities sold, not inferred from generic sales totals.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const resolved=resolvePeriod(period.parse(raw).period,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"});
      if(resolved.status!=="resolved")return periodChoicePayload("item_sales",resolved);
      const p={from:resolved.value.from,to:resolved.value.to};
      if(!ctx.tools.getProductSales)return {source:"item_sales",period:p,agentId:"alex",missing:["itemSalesReaderUnavailable"]};
      const s=await ctx.tools.getProductSales(p);
      if(!s.available)return {source:"item_sales",period:p,agentId:"alex",missing:s.quality.missingInputs,items:null};
      const sorted=[...s.value].sort((a,b)=>b.units-a.units);
      return {source:"item_sales",period:p,agentId:"alex",
        missing:[...s.quality.missingInputs,...(sorted.length>15?["itemSalesTruncated"]:[])],
        itemCount:sorted.length,items:sorted.slice(0,15)};
    },
  },
  get_price_recommendation:{
    agentId:"alex",schema:item,description:"Read the deterministic recommendation for one menu item; never auto-update price.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {itemId}=item.parse(raw);
      const menu=await ctx.tools.getMenuCatalog();
      if(!menu.available)return {source:"pricing_engine",period:null,missing:menu.quality.missingInputs};
      const product=menu.value.find(row=>row.active&&row.id===itemId);
      if(!product)return {source:"pricing_engine",period:null,missing:["notFound"]};
      const resolved=resolveEntity("product",product.name,menu.value.filter(row=>row.active),{nameOf:r=>r.name,idOf:r=>r.id,describe:r=>r.category+" · "+(r.priceCents/100).toFixed(2)});
      if(resolved.status==="ambiguous"&&!ctx.resolveState?.chosenIds.has(itemId.toLowerCase()))
        return {...choicePayload(resolved,"pricing_engine",null),agentId:"alex"};
      if(!ctx.tools.getPricingRecommendation)return {source:"pricing_engine",period:null,agentId:"alex",missing:["pricingReaderUnavailable"]};
      const s=await ctx.tools.getPricingRecommendation(itemId);
      if(!s.available)return {source:"pricing_engine",period:null,agentId:"alex",missing:s.quality.missingInputs};
      const v=s.value;
      return {source:"pricing_engine",period:null,agentId:"alex",
        missing:[...new Set([...s.quality.missingInputs,...v.dataQuality.missingInputs])],
        estimated:[...new Set([...s.quality.estimatedInputs,...v.dataQuality.estimatedInputs])],
        stale:[...new Set([...s.quality.staleInputs,...v.dataQuality.staleInputs])],
        itemId,status:v.status,confidence:v.confidence,mode:v.calculationMode,
        currentPriceCents:v.currentPriceCents,recommendedPriceCents:v.recommendedPriceCents,
        productCostCents:v.productCostCents,warnings:v.warnings};
    },
  },
} as const;
