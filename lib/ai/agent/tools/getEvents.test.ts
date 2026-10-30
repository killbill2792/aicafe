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
  expect(tool?.parameters.required).toEqual(["from","to"]);
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
 it("does not turn missing storage or a reversed range into a false no-events answer",async()=>{
  const absent=await executeAgentTool("get_events",{from:"2026-10-30",to:"2026-11-01"},context(undefined));
  expect(absent.missing).toEqual(["savedEventsUnavailable"]);
  await expect(executeAgentTool("get_events",{from:"2026-11-01",to:"2026-10-30"},
   context(vi.fn()))).rejects.toThrow();
 });
});
