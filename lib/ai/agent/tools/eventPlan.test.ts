import {describe,expect,it,vi} from "vitest";
import {eventPlanTools} from "./eventPlan";
import type {AgentToolContext} from "./index";
const id="11111111-1111-4111-8111-111111111111";
const input={startDate:"2026-11-01",endDate:"2026-11-01",
 eventIds:[id],summary:"Prepare for a confirmed local parade",
 expectedBusyHours:[{start:"11:00",end:"13:00"}],
 actions:[{area:"prep" as const,action:"Prepare a small stock buffer",
   reason:"The confirmed parade route passes the café"}]};
const context=():AgentToolContext=>({
 timezone:"America/Los_Angeles",asOf:"2026-10-30",locale:"en",
 tools:{
   getProfitability:vi.fn(),getSalesTrend:vi.fn(),getMenuCatalog:vi.fn(),
 },
});
describe("strict propose_event_plan tool",()=>{
 it("creates only a draft through the provided existing Supervisor-loop port",async()=>{
  const ctx=context(),propose=vi.fn().mockResolvedValue({
    proposalId:id,revision:0,
  });
  ctx.eventPlans={propose};
  expect(await eventPlanTools.propose_event_plan.execute(input,ctx)).toMatchObject({
    source:"event_plan_proposal",agentId:"alex",draft:true,saved:false,
    proposalId:id,revision:0,missing:[],
  });
  expect(propose).toHaveBeenCalledExactlyOnceWith(input);
 });
 it("never writes or claims completion when there is no authorized port",async()=>{
  const result=await eventPlanTools.propose_event_plan.execute(input,context());
  expect(result).toMatchObject({missing:["eventPlanningUnavailable"]});
  expect(result).not.toHaveProperty("proposalId");
 });
 it("rejects fake event IDs, no actions or unapproved execution fields",async()=>{
  const ctx=context();
  await expect(eventPlanTools.propose_event_plan.execute({
    ...input,eventIds:["wrong"],actions:[],
  },ctx)).rejects.toThrow();
  await expect(eventPlanTools.propose_event_plan.execute({
    ...input,execute:true,
  },ctx)).rejects.toThrow();
 });
});
