import { z } from "zod";
import { requestedPeriod } from "./period";
import type { AgentToolContext, AgentToolResult } from "./index";
import {ownerInputsSchema} from "./ownerInputs";
import {resolveCoveredSalesWindow} from "./coverage";

const period=z.strictObject({period:z.enum(["today","week","month"])});
const item=z.strictObject({itemId:z.uuid(),ownerInputs:ownerInputsSchema.nullable().optional()});
export const salesTools={
  get_item_sales:{
    agentId:"alex",schema:period,description:"Covered item quantities sold, not inferred from generic sales totals.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const selection=await resolveCoveredSalesWindow(ctx,requestedPeriod(period.parse(raw).period,ctx.asOf));
      const p=selection.period;
      if(!ctx.tools.getProductSales)return {source:"item_sales",period:p,agentId:"alex",missing:["itemSalesReaderUnavailable"]};
      const s=await ctx.tools.getProductSales(p);
      if(!s.available)return {source:"item_sales",period:p,agentId:"alex",missing:s.quality.missingInputs,items:null};
      const sorted=[...s.value].sort((a,b)=>b.units-a.units);
      return {source:"item_sales",period:p,coverageLabel:selection.label,agentId:"alex",
        missing:[...s.quality.missingInputs,...(sorted.length>15?["itemSalesTruncated"]:[])],
        itemCount:sorted.length,items:sorted.slice(0,15)};
    },
  },
  get_price_recommendation:{
    agentId:"alex",schema:item,description:"Read the deterministic recommendation for one menu item; never auto-update price.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {itemId,ownerInputs}=item.parse(raw);
      if(!ctx.tools.getPricingRecommendation)return {source:"pricing_engine",period:null,agentId:"alex",missing:["pricingReaderUnavailable"]};
      const s=await ctx.tools.getPricingRecommendation(itemId);
      if(!s.available)return {source:"pricing_engine",period:null,agentId:"alex",missing:s.quality.missingInputs};
      const v=s.value;
      return {source:"pricing_engine",period:null,agentId:"alex",
        missing:[...new Set([...s.quality.missingInputs,...v.dataQuality.missingInputs])],
        estimated:[...new Set([...s.quality.estimatedInputs,...v.dataQuality.estimatedInputs])],
        stale:[...new Set([...s.quality.staleInputs,...v.dataQuality.staleInputs])],
        itemId,unit:"cents",ownerInputs,status:v.status,confidence:v.confidence,mode:v.calculationMode,
        currentPriceCents:v.currentPriceCents,recommendedPriceCents:v.recommendedPriceCents,
        productCostCents:v.productCostCents,warnings:v.warnings};
    },
  },
} as const;
