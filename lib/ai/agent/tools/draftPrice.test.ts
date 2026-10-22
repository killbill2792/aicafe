import {describe,it,expect} from "vitest";
import {executeAgentTool,agentToolDefinitions,type AgentToolContext} from "./index";
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const yes=<T>(value:T)=>({available:true as const,value,quality});
const ctx=():AgentToolContext=>({asOf:"2026-10-22",timezone:"America/Los_Angeles",locale:"en",tools:{
 getProfitability:async()=>yes({} as never),getSalesTrend:async()=>yes([]),getMenuCatalog:async()=>yes([{id:"a",name:"Drink",category:"drink",active:true,priceCents:500}]),
 getSchedulingDraftInputs:async()=>yes({employees:[],schedules:[],availability:[],preferences:[],openHours:null,timezone:"America/Los_Angeles",city:"SF",region:"CA",countryCode:"US"}),
 getLaborMetrics:async()=>yes([{date:"2026-10-22",loadedStaffCostCents:90000,wagesCents:0,staffTaxCents:0}]),
 getProductSales:async()=>yes([{id:"a",name:"Drink",category:"drink",units:1000}]),
 getMonthlyBills:async()=>yes({totalCents:60000})
 }});
describe("agent read only capabilities",()=>{
 it("strictly validates schemas",async()=>{
  for(const name of ["draft_week_schedule","suggest_new_item_price"]){
   const def=agentToolDefinitions.find(t=>t.name===name);
   expect(def?.strict).toBe(true);expect(def?.parameters.additionalProperties).toBe(false);
   expect(def?.parameters.required).toEqual(Object.keys(def?.parameters.properties??{}));
  }
  await expect(executeAgentTool("draft_week_schedule",{week_start:null,write:true},ctx())).rejects.toThrow();
  await expect(executeAgentTool("draft_week_schedule",{week_start:"2026-10-27"},ctx())).rejects.toThrow();
  await expect(executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:0,category:"drink",packaging_cents:null,target_margin_percent:null,item_name:null},ctx())).rejects.toThrow();
 });
 it("returns a draft and explicit missing business hours",async()=>{
  const r=await executeAgentTool("draft_week_schedule",{week_start:null},ctx());
  expect(r).toMatchObject({source:"schedule_draft",agentId:"olivia",draft:true,saved:false,weekStart:"2026-10-26"});
  expect(r.missing).toContain("businessHoursNotSet");
 });
 it("keeps pricing available if the optional location reader throws",async()=>{
  const context=ctx();
  context.tools.getSchedulingDraftInputs=async()=>{throw new Error("Location database temporarily unavailable");};
  const r=await executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:140,category:"drink",packaging_cents:20,target_margin_percent:null,item_name:null},context);
  expect(r.suggestedPriceCents).toBe(475);
  expect(r.location).toBeNull();
  expect(r.missing).toContain("locationUnavailable");
 });
 it("returns full pricing components without competitor fabrication",async()=>{
  const r=await executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:140,category:"drink",packaging_cents:20,target_margin_percent:null,item_name:"Latte"},ctx());
  expect(r).toMatchObject({agentId:"alex",saved:false,suggestedPriceCents:475,categoryUnits30d:1000,localCompetitorPrices:null,location:{city:"SF"}});
  expect(r.missing).toContain("localCompetitorPricesNotAvailable");
 });
});
