import {describe,expect,it,vi} from "vitest";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";

const context=(read:AgentToolContext["savedEvents"]):AgentToolContext=>({
 timezone:"America/Chicago",locale:"en",asOf:"2026-10-30",tools:{} as AgentToolContext["tools"],
 savedEvents:read,
});

describe("get_events: saved-only, owner-scoped read",()=>{
 it("publishes a strict schema and never accepts a café id from the model",async()=>{
  const tool=agentToolDefinitions.find(t=>t.name==="get_events");
  expect(tool?.strict).toBe(true);
  expect(tool?.parameters.required).toEqual(["from","to","cityEventId"]);
  await expect(executeAgentTool("get_events",{from:"2026-10-01",to:"2026-10-31",businessId:"other"},
   context(vi.fn()))).rejects.toThrow();
 });
 it("returns historical plans and report status without web search",async()=>{
  const savedEvents=vi.fn(async()=>({events:[{id:"e1",name:"Halloween"}] as never[],
   plans:[{proposalId:"p1",status:"committed",reportStatus:"complete"}] as never[]}));
  const r=await executeAgentTool("get_events",{from:"2026-10-01",to:"2026-11-01"},
   context(savedEvents as AgentToolContext["savedEvents"]));
  expect(savedEvents).toHaveBeenCalledWith("2026-10-01","2026-11-01");
  expect(r).toMatchObject({source:"cafe_events",searched:false,empty:false,
   plans:[{proposalId:"p1",reportStatus:"complete"}],events:[{name:"Halloween"}]});
 });
 it("bounds large event reports before they enter the model context",async()=>{
  const saved=vi.fn(async()=>({
   events:Array.from({length:12},(_,i)=>({id:String(i),name:"Event "+i})),
   plans:Array.from({length:8},(_,i)=>({proposalId:String(i),status:"committed",
     reportStatus:"complete",report:{observedDays:14,expectedDays:14,
       days:Array.from({length:14},(_,j)=>({date:"2026-10-31",actualCents:10000+j,
         typicalCents:9000,hours:Array.from({length:24},()=>({actualCents:1000}))}))}})),
  }));
  const r=await executeAgentTool("get_events",{from:"2026-10-01",to:"2026-11-01"},
   context(saved as unknown as AgentToolContext["savedEvents"]));
  expect((r.events as unknown[])).toHaveLength(8);
  expect((r.plans as unknown[])).toHaveLength(5);
  expect(r.omittedEvents).toBe(4);
  expect(r.omittedPlans).toBe(3);
  const report=(r.plans as Array<{report:{days:unknown[];additionalDays:number}}>)[0].report;
  expect(report.days).toHaveLength(7);
  expect(report.additionalDays).toBe(7);
  expect(JSON.stringify(r)).not.toContain('"hours"');
 });
 it("returns the six earliest saved city events without changing their identities",async()=>{
   const items=Array.from({length:8},(_,i)=>({
     id:"city-"+i,name:"Event "+i,startDate:"2026-11-"+String(12-i).padStart(2,"0"),
     lastVerifiedAt:i%2===0?"2026-11-01T10:00:00Z":null,
   }));
   const saved=vi.fn(async()=>({events:[],plans:[],cityCatalog:{
     available:true,total:8,page:0,items,
   }}));
   const r=await executeAgentTool("get_events",{from:"2026-11-01",to:"2026-11-20"},
     context(saved as unknown as AgentToolContext["savedEvents"]));
   const city=r.cityEvents as typeof items;
   expect(city.map(e=>e.id)).toEqual(["city-7","city-6","city-5","city-4","city-3","city-2"]);
   expect(r.omittedCityEvents).toBe(2);
 });
 it("does not turn missing storage or a reversed range into a false no-events answer",async()=>{
  const absent=await executeAgentTool("get_events",{from:"2026-10-30",to:"2026-11-01"},context(undefined));
  expect(absent.missing).toEqual(["savedEventsUnavailable"]);
  await expect(executeAgentTool("get_events",{from:"2026-11-01",to:"2026-10-30"},
   context(vi.fn()))).rejects.toThrow();
 });
});
