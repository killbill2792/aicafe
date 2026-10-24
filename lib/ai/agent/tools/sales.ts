import { z } from "zod";
import type {MenuCatalogProduct} from "@/lib/ai/supervisorReads.server";
import type {SoldProduct} from "@/lib/ai/supervisorFacts.server";
import type {DataQuality} from "@/lib/calc";
import {resolvePeriod} from "@/lib/calc/periods";
import {resolveEntity,choicePayload,periodChoicePayload} from "../resolve";
import type { AgentToolContext, AgentToolResult } from "./index";
import {estimatedItemRevenueCents} from "@/lib/calc/itemSalesRevenue";
import {safeDifferenceCents} from "@/lib/calc/explainMath";
import {money,count} from "../explain";

const period=z.strictObject({period:z.union([z.string().min(1).max(32),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})]),query:z.string().trim().max(120).nullable().optional()});
const item=z.strictObject({itemId:z.uuid()});
function presentItemSales(rows:readonly SoldProduct[],menu:readonly MenuCatalogProduct[],
  p:{from:string;to:string},quality:DataQuality):AgentToolResult{
  const sorted=[...rows].sort((a,b)=>b.units-a.units);
  const prices=new Map(menu.filter(item=>item.active).map(item=>[item.id,item.priceCents]));
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
    missing:[...quality.missingInputs,...(sorted.length>15?["itemSalesTruncated"]:[])],
    estimated:explain.length?["currentMenuPriceNotHistoricalSoldPrice"]:[],
    itemCount:sorted.length,items:displayed,explain};
}

export const salesTools={
  get_item_sales:{
    agentId:"alex",schema:period,description:"Covered item quantities sold. When the owner names an item, pass query (otherwise null), and ask_owner if multiple menu products match; never pick the first.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=period.parse(raw);
      const resolved=resolvePeriod(input.period,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"});
      if(resolved.status!=="resolved")return periodChoicePayload("item_sales",resolved);
      const p={from:resolved.value.from,to:resolved.value.to};
      if(!ctx.tools.getProductSales)return {source:"item_sales",period:p,agentId:"alex",missing:["itemSalesReaderUnavailable"]};
      const s=await ctx.tools.getProductSales(p);
      if(!s.available)return {source:"item_sales",period:p,agentId:"alex",missing:s.quality.missingInputs,items:null};
      const menu=await ctx.tools.getMenuCatalog();
      if(input.query){
        if(!menu.available)return {source:"item_sales",period:p,agentId:"alex",
          missing:menu.quality.missingInputs.length?menu.quality.missingInputs:["menuReaderUnavailable"]};
        const named=resolveEntity("product",input.query,menu.value.filter(row=>row.active),{
          nameOf:r=>r.name,idOf:r=>r.id,describe:r=>r.category+" · "+(r.priceCents/100).toFixed(2)});
        if(named.status!=="resolved")return {...choicePayload(named,"item_sales",p),agentId:"alex"};
        // A valid item may have zero recorded sales. Never infer zero units from
        // an unrelated drink with a similar label.
        const selected=s.value.filter(row=>row.id===named.value.id);
        return presentItemSales(selected,menu.value,p,s.quality);
      }
      return presentItemSales(s.value,menu.available?menu.value:[],p,s.quality);

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
