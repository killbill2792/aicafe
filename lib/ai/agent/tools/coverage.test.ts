import {describe,it,expect} from "vitest";
import {resolveCoveredSalesWindow} from "./coverage";
import {executeAgentTool} from "./index";
import {salesTools} from "./sales";
import type {AgentToolContext} from "./index";
const fakeDate=(date:string)=>({date});
const unavailable=()=>({available:false as const,value:null,quality:{level:"low" as const,missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}});
function context(dates:string[]):AgentToolContext{
 return {asOf:"2026-10-24",locale:"en",timezone:"America/Los_Angeles",tools:{
   getSalesTrend:async({from,to})=>{
    const filtered=dates.filter(d=>d>=from&&d<=to);
    return filtered.length?{available:true,value:filtered.map(fakeDate) as never,
       quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}:unavailable();
   },
   getProfitability:async()=>unavailable(),getMenuCatalog:async()=>unavailable(),
 }};
}
describe("latest covered sales window",()=>{
 it("does not substitute an older period for month in profit or item-sales",async()=>{
  const dates=["2026-09-01","2026-09-02"];
  const requested={from:"2026-10-01",to:"2026-10-24"};
  const profit=await executeAgentTool("get_profit",{period:"month",ownerInputs:null},context(dates));
  expect(profit).toMatchObject({period:requested,coverageFallback:null});
  const items=await salesTools.get_item_sales.execute({period:"month",query:null},context(dates));
  expect(items).toMatchObject({period:requested,coverageFallback:null});
 });
 it("today not imported returns lastFullDay and does not swap period",async()=>{
  const ctx=context(["2026-10-23"]);
  const result=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
  expect(result).toMatchObject({period:{from:ctx.asOf,to:ctx.asOf},
    todayImported:false,lastFullDay:"2026-10-23",coverageFallback:null});
  expect(result.dataNote).toContain("Today isn't imported yet");
 });
 it("returns honest today for preset objects and explicit local dates",async()=>{
  const ctx=context(["2026-10-23"]);
  const preset=await executeAgentTool("get_sales",{period:{preset:"today"},ownerInputs:null},ctx);
  const explicit=await executeAgentTool("get_sales",{period:{from:ctx.asOf,to:ctx.asOf},ownerInputs:null},ctx);
  for(const result of [preset,explicit]){
   expect(result).toMatchObject({period:{from:ctx.asOf,to:ctx.asOf},
    todayImported:false,lastFullDay:"2026-10-23"});
   expect(result.dataNote).toContain("Today isn't imported yet");
  }
 });
 it("preserves the requested period when the optional trend reader is absent",async()=>{
  const ctx=context([]);
  const tools={...ctx.tools};
  delete (tools as {getSalesTrend?:unknown}).getSalesTrend;
  expect(await resolveCoveredSalesWindow({...ctx,tools} as AgentToolContext,
    {from:"2026-10-18",to:"2026-10-24"})).toEqual({
      period:{from:"2026-10-18",to:"2026-10-24"},label:null,coverageFallback:null});
 });
 it("keeps historical request boundaries even if older data exists",async()=>{
  const r=await resolveCoveredSalesWindow(context(["2026-08-22","2026-09-04"]),{from:"2026-10-01",to:"2026-10-24"});
  expect(r).toEqual({period:{from:"2026-10-01",to:"2026-10-24"},label:null,coverageFallback:null});
 });
 it("keeps a currently covered period",async()=>{
  expect(await resolveCoveredSalesWindow(context(["2026-10-24"]),{from:"2026-10-01",to:"2026-10-24"})).toEqual({
   period:{from:"2026-10-01",to:"2026-10-24"},label:null,coverageFallback:null});
 });
 it("does not fabricate covered dates",async()=>{
  const requested={from:"2026-10-01",to:"2026-10-24"};
  expect(await resolveCoveredSalesWindow(context([]),requested)).toEqual({period:requested,label:null,coverageFallback:null});
 });
});
