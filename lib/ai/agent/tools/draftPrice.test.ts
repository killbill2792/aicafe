import {describe,it,expect,vi} from "vitest";
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
  await expect(executeAgentTool("draft_week_schedule",{week_start:null,purpose:"draft",write:true},ctx())).rejects.toThrow();
  await expect(executeAgentTool("draft_week_schedule",{week_start:"2026-10-27",purpose:"draft"},ctx())).rejects.toThrow();
  await expect(executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:0,category:"drink",packaging_cents:null,item_name:null},ctx())).rejects.toThrow();
 });
 it("uses Olivia's feature-gated draft path instead of falling back to the retired scheduler",async()=>{
  vi.stubEnv("SCHEDULING_FOUNDATION_ENABLED","false");
  vi.stubEnv("SCHEDULING_PR3_DRAFTS_ENABLED","false");
  try{
   const r=await executeAgentTool("draft_week_schedule",{week_start:null,purpose:"draft"},ctx());
   expect(r).toMatchObject({source:"olivia_schedule",agentId:"olivia",
    draft:true,saved:false,missing:["disabled"]});
   expect(r).not.toHaveProperty("days");
  }finally{vi.unstubAllEnvs();}
 });
 it("keeps pricing available if the optional location reader throws",async()=>{
  const context=ctx();
  context.tools.getSchedulingDraftInputs=async()=>{throw new Error("Location database temporarily unavailable");};
  const r=await executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:140,category:"drink",packaging_cents:20,item_name:null},context);
  expect(r.suggestedPriceCents).toBe(475);
  expect(r.location).toBeNull();
  expect(r.missing).toContain("locationUnavailable");
 });
 it("keeps rent-only overhead partial instead of treating missing bills as zero",async()=>{
  const context=ctx();
  context.tools.getMonthlyBills=async()=>({available:false,value:null,quality:{
    level:"low",missingInputs:["billsNotConnected"],estimatedInputs:[],staleInputs:[],
  }});
  const ownerInputs={netSalesCents:null,salesPeriod:null,laborCents:null,laborPeriod:null,
    rentCents:300000,otherOverheadCents:null,
    overheadPeriod:{from:"2026-10-01",to:"2026-10-31"},
    unitCostCents:null,itemsSoldPerDay:null};
  const r=await executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:100,
    category:"drink",packaging_cents:300,item_name:"Latte",
    ownerInputs},context);
  expect(r.overheadCoverage).toBe("partial");
  expect(r.overheadPerDayCents).toBeNull();
  expect(r.drinksPerDayToCoverOverhead).toBeNull();
  expect(r.knownOverheadPerDayCents).toBeGreaterThan(0);
  expect(r.fullCostCents).toBeNull();
  expect((r.result as {tier:string}).tier).toBe("partial");
  expect(r.missing).toContain("ownerOverheadIncomplete");
  expect(r.missing).toContain("monthlyBills");
  expect(r.suggestedPriceCents).toBeGreaterThanOrEqual(r.knownUnitCostCents as number);
 });
 it("returns full pricing components without competitor fabrication",async()=>{
  const r=await executeAgentTool("suggest_new_item_price",{ingredient_cost_cents:140,category:"drink",packaging_cents:20,item_name:"Latte"},ctx());
  expect(r).toMatchObject({agentId:"alex",saved:false,suggestedPriceCents:475,categoryUnits30d:1000,localCompetitorPrices:null,location:{city:"SF"}});
  expect(r.missing).toContain("localCompetitorPricesNotAvailable");
 });
});
