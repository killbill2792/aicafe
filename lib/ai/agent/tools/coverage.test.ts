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
 it("today lookup outage keeps last-day evidence and labels uncertainty",async()=>{
  const ctx=context(["2026-10-23"]);
  const original=ctx.tools.getSalesTrend;
  let calls=0;
  ctx.tools.getSalesTrend=async(p)=>{if(++calls===1)throw Error("db down");return original(p);};
  const result=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
  expect(result.period).toEqual({from:ctx.asOf,to:ctx.asOf});
  expect(result.todayImported).toBeUndefined();
  expect(result.lastFullDay).toBe("2026-10-23");
  expect(result.dataNote).toContain("couldn't be checked");
 });
 it("failed last-day reader never crashes an honest today response",async()=>{
  const ctx=context([]);
  const original=ctx.tools.getSalesTrend;
  ctx.tools.getSalesTrend=async(p)=>{
   if(p.to<ctx.asOf)throw Error("history unavailable");
   return original(p);
  };
  const result=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
  expect(result).toMatchObject({period:{from:ctx.asOf,to:ctx.asOf},
   todayImported:false,lastFullDay:null});
  expect(result.dataNote).toContain("couldn't be checked");
 });
 it("pricing fallback read errors preserve the requested pricing window",async()=>{
  const ctx=context([]);
  ctx.tools.getSalesTrend=async()=>{throw Error("offline");};
  const result=await resolveCoveredSalesWindow(ctx,{from:"2026-10-01",to:"2026-10-24"});
  expect(result).toMatchObject({period:{from:"2026-10-01",to:"2026-10-24"},coverageFallback:null});
 });
 it("preserves the requested period when the optional trend reader is absent",async()=>{
  const ctx=context([]);
  const tools={...ctx.tools};
  delete (tools as {getSalesTrend?:unknown}).getSalesTrend;
  expect(await resolveCoveredSalesWindow({...ctx,tools} as AgentToolContext,
    {from:"2026-10-18",to:"2026-10-24"})).toEqual({
      period:{from:"2026-10-18",to:"2026-10-24"},label:null,coverageFallback:null});
 });
 it("keeps legacy historical coverage for pricing without swapping chat periods",async()=>{
  const old=["2026-09-01","2026-09-02"];
  const r=await resolveCoveredSalesWindow(context(old),{from:"2026-10-01",to:"2026-10-24"});
  expect(r).toMatchObject({period:{from:"2026-09-01",to:"2026-09-02"},
    coverageFallback:{requested:{from:"2026-10-01",to:"2026-10-24"},
      used:{from:"2026-09-01",to:"2026-09-02"}}});
  const chat=await executeAgentTool("get_profit",{period:"month",ownerInputs:null},context(old));
  expect(chat.period).toEqual({from:"2026-10-01",to:"2026-10-24"});
  expect(chat.coverageFallback).toBeNull();
 });
 it("latest-data fallback is translated in Spanish and Arabic",async()=>{
  const old=["2026-09-01","2026-09-02"];
  for(const locale of ["es","ar"] as const){
   const state=await resolveCoveredSalesWindow({...context(old),locale},{from:"2026-10-01",to:"2026-10-24"});
   expect(state.label).toContain(locale==="es"?"Últimos datos":"أحدث البيانات");
   expect(state.label).not.toContain("Latest data");
   expect(state.labelKey).toBe("periodLatestData");
  }
 });
 it("today-not-imported money uses localized currency in EN/ES/AR",async()=>{
  for(const locale of ["en","es","ar"] as const){
   const ctx={...context(["2026-10-23"]),locale};
   const read=ctx.tools.getSalesTrend;
   ctx.tools.getSalesTrend=async p=>{
    const result=await read(p);
    return result.available?{...result,value:result.value.map(row=>({...row,netSalesCents:41230}))}:result;
   };
   const value=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
   expect(value.dataNote).toContain(new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(412.30));
  }
 });
 it("keeps a currently covered period",async()=>{
  expect(await resolveCoveredSalesWindow(context(["2026-10-24"]),{from:"2026-10-01",to:"2026-10-24"})).toEqual({
   period:{from:"2026-10-01",to:"2026-10-24"},label:null,coverageFallback:null});
 });
 it("does not fabricate covered dates",async()=>{
  const requested={from:"2026-10-01",to:"2026-10-24"};
  expect(await resolveCoveredSalesWindow(context([]),requested)).toEqual({period:requested,label:null,coverageFallback:null});
 });
 it("a stored historical day with failed import is not called a full day",async()=>{
  const ctx=context(["2026-10-23"]);
  const read=ctx.tools.getSalesTrend;
  ctx.tools.getSalesTrend=async(p)=>{
   const result=await read(p);
   if(p.from==="2026-10-23"&&p.to==="2026-10-23"&&result.available)
    return {...result,quality:{...result.quality,missingInputs:["toastImportIncompleteDays:1:2026-10-23:0"]}};
   return result;
  };
  const result=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
  expect(result.lastFullDay).toBeNull();
  expect(result.lastRecordedDay).toBe("2026-10-23");
  expect(result.lastFullDayTotals).toBeNull();
  expect(result.dataNote).toContain("completeness unverified");
 });
 it("today's item sales include the missing-import note even when item rows exist",async()=>{
  const ctx=context(["2026-10-23"]);
  ctx.tools.getProductSales=async()=>({available:true,value:[
   {id:"11111111-1111-4111-8111-111111111111",name:"Latte",category:"drink",units:3}
  ],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}});
  ctx.tools.getMenuCatalog=async()=>({available:true,value:[],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}});
  const response=await salesTools.get_item_sales.execute({period:"today",query:null},ctx);
  expect(response.items).toHaveLength(1);
  expect(response.lastFullDay).toBe("2026-10-23");
  expect(response.dataNote).toContain("Today isn't imported yet");
 });
 it("item-sales failures preserve the today check caveat",async()=>{
  const ctx=context(["2026-10-23"]);
  ctx.tools.getProductSales=async()=>{throw Error("offline");};
  const response=await salesTools.get_item_sales.execute({period:"today",query:null},ctx);
  expect(response.missing).toContain("itemSalesReadFailed");
  expect(response.lastFullDay).toBe("2026-10-23");
  expect(response.dataNote).toContain("Today isn't imported yet");
 });

 it("item-sales stays partial and labeled when menu lookup throws",async()=>{
  const ctx=context(["2026-10-23"]);
  ctx.tools.getProductSales=async()=>({available:true,value:[
   {id:"11111111-1111-4111-8111-111111111111",name:"Latte",category:"drink",units:2}
  ],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}});
  ctx.tools.getMenuCatalog=async()=>{throw Error("menu unavailable");};
  const response=await salesTools.get_item_sales.execute({period:"today",query:null},ctx);
  expect(response.items).toHaveLength(1);
  expect(response.missing).toContain("menuReadFailed");
  expect(response.dataNote).toContain("Today isn't imported yet");
 });

 it("stored today with a queued import stays visible but unverified",async()=>{
  const ctx=context(["2026-10-24"]);
  const read=ctx.tools.getSalesTrend;
  ctx.tools.getSalesTrend=async(p)=>{
   const result=await read(p);
   if(p.from===ctx.asOf&&p.to===ctx.asOf&&result.available)
    return {...result,quality:{...result.quality,missingInputs:["toastImportIncompleteDays:1:2026-10-24:0"]}};
   return result;
  };
  const result=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
  expect(result.todayImported).toBeUndefined();
  expect(result.lastFullDay).toBeNull();
  expect(result.lastRecordedDay).toBe(ctx.asOf);
  expect(result.dataNote).toContain("stored");
  expect(result.dataNote).toContain("not verified");
 });
 it("no sales rows plus an errored Toast status is a failed today check",async()=>{
  const ctx=context([]);
  ctx.tools.getSalesTrend=async()=>({available:false,value:null,quality:{
   level:"low",missingInputs:["noCoveredSalesRows","toastDayStatusUnavailable"],
   estimatedInputs:[],staleInputs:[]
  }});
  const result=await resolveCoveredSalesWindow(ctx,{from:ctx.asOf,to:ctx.asOf});
  expect(result.todayImported).toBeUndefined();
  expect(result.lastFullDay).toBeNull();
  expect(result.dataNote).toContain("couldn't be checked");
  expect(result.dataNote).not.toContain("Today isn't imported yet");
 });

});
