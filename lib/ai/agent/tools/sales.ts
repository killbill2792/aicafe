import { z } from "zod";
import {resolvePeriod} from "@/lib/calc/periods";
import {resolveEntity,choicePayload,periodChoicePayload} from "../resolve";
import type { AgentToolContext, AgentToolResult } from "./index";
import {estimatedItemRevenueCents} from "@/lib/calc/itemSalesRevenue";
import {safeDifferenceCents} from "@/lib/calc/explainMath";
import {money,count} from "../explain";

const period=z.strictObject({period:z.union([z.string().min(1).max(32),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})])});
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
      const menu=await ctx.tools.getMenuCatalog();
      const prices=new Map(menu.available?menu.value.filter(item=>item.active).map(item=>[item.id,item.priceCents]):[]);
      const displayed=sorted.slice(0,15).map(item=>{
        const price=prices.get(item.id);
        const illustrativeRevenueCents=price===undefined?null:estimatedItemRevenueCents(item.units,price);
        return {...item,illustrativeRevenueCents,currentMenuPriceCents:price??null};
      });
      const explain=displayed.slice(0,12).flatMap(item=>{
        if(item.illustrativeRevenueCents===null||item.currentMenuPriceCents===null)return [];
        return [{label:item.name,inputs:[{name:"qtySold",value:count(item.units)},
          {name:"unitPrice",value:money(item.currentMenuPriceCents)}],
          formula:"multiply" as const,result:money(item.illustrativeRevenueCents),period:p,
          source:"get_item_sales",provenance:"estimate" as const}];
      });
      return {source:"item_sales",period:p,agentId:"alex",
        missing:[...s.quality.missingInputs,...(sorted.length>15?["itemSalesTruncated"]:[])],
        estimated:explain.length?["currentMenuPriceNotHistoricalSoldPrice"]:[],
        itemCount:sorted.length,items:displayed,explain};
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
      const grossProfitPerItemCents=v.currentPriceCents!==null&&v.productCostCents!==null?
        safeDifferenceCents(v.currentPriceCents,v.productCostCents):null;
      return {source:"pricing_engine",period:null,agentId:"alex",
        missing:[...new Set([...s.quality.missingInputs,...v.dataQuality.missingInputs])],
        estimated:[...new Set([...s.quality.estimatedInputs,...v.dataQuality.estimatedInputs])],
        stale:[...new Set([...s.quality.staleInputs,...v.dataQuality.staleInputs])],
        itemId,status:v.status,confidence:v.confidence,mode:v.calculationMode,
        currentPriceCents:v.currentPriceCents,recommendedPriceCents:v.recommendedPriceCents,
        productCostCents:v.productCostCents,grossProfitPerItemCents,warnings:v.warnings,
        explain:grossProfitPerItemCents===null?[]:[{label:product.name,
          inputs:[{name:"unitPrice",value:money(v.currentPriceCents!)},
                  {name:"cost",value:money(v.productCostCents!)}],
          formula:"subtract",result:money(grossProfitPerItemCents),period:null,
          source:"get_price_recommendation",provenance:s.quality.estimatedInputs.length?"estimate":"recorded"}]};
    },
  },
} as const;
