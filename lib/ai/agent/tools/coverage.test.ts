import {describe,it,expect} from "vitest";
import {resolveCoveredSalesWindow} from "./coverage";
import type {AgentToolContext} from "./index";
const fakeDate=(date:string)=>({date});
const unavailable=()=>({available:false as const,value:null,quality:{level:"low" as const,missingInputs:["noCoveredSalesRows"],estimatedInputs:[],staleInputs:[]}});
function context(dates:string[]):AgentToolContext{
 return {asOf:"2026-10-24",locale:"en",tools:{
   getSalesTrend:async({from,to})=>{
    const filtered=dates.filter(d=>d>=from&&d<=to);
    return filtered.length?{available:true,value:filtered.map(fakeDate) as never,
       quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}:unavailable();
   },
   getProfitability:async()=>unavailable(),getMenuCatalog:async()=>unavailable(),
 }};
}
describe("latest covered sales window",()=>{
 it("falls back to actual imported coverage instead of declaring no data",async()=>{
  const dates=Array.from({length:14},(_,i)=>new Date(Date.UTC(2026,7,22+i)).toISOString().slice(0,10));
  expect(await resolveCoveredSalesWindow(context(dates),{from:"2026-10-01",to:"2026-10-24"})).toEqual({
   period:{from:"2026-08-22",to:"2026-09-04"},label:"Latest data: Aug 22–Sep 4"});
 });
 it("keeps a currently covered period",async()=>{
  expect(await resolveCoveredSalesWindow(context(["2026-10-24"]),{from:"2026-10-01",to:"2026-10-24"})).toEqual({
   period:{from:"2026-10-01",to:"2026-10-24"},label:null});
 });
 it("does not fabricate covered dates",async()=>{
  const requested={from:"2026-10-01",to:"2026-10-24"};
  expect(await resolveCoveredSalesWindow(context([]),requested)).toEqual({period:requested,label:null});
 });
});
