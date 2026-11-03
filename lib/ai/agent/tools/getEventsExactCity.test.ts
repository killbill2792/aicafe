import {describe,expect,it,vi} from "vitest";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";

const exactId="77777777-7777-4777-8777-777777777777";
const otherId="11111111-1111-4111-8111-111111111111";
const date="2026-11-05";
const cityEvent={
  id:exactId,name:"Convention Fair",kind:"conference",startDate:date,endDate:date,
  startTime:"10:00",endTime:"16:00",timeSourceUrl:"https://civic.example.org/time",
  venue:"Civic Hall",venueAddress:"1 Main St",checkedAt:"2026-11-03T07:00:00Z",
  sources:[{url:"https://civic.example.org/fair",observedAt:"2026-11-03T07:00:00Z"}],
  cafeEventId:null,status:null,lastVerifiedAt:null,
};
const context=(savedEvents:NonNullable<AgentToolContext["savedEvents"]>):AgentToolContext=>({
  timezone:"America/Los_Angeles",locale:"en",asOf:"2026-11-03",
  tools:{} as AgentToolContext["tools"],savedEvents,
});

describe("G exact owner-selected city event via existing get_events and canonical port",()=>{
  it("exposes a strict nullable cityEventId with no café scope chosen by the model",()=>{
    const tool=agentToolDefinitions.find(x=>x.name==="get_events");
    expect(tool?.strict).toBe(true);
    expect(tool?.parameters.required).toEqual(["from","to","cityEventId"]);
    expect(JSON.stringify(tool?.parameters.properties?.cityEventId)).toContain("null");
    expect(JSON.stringify(tool?.parameters)).not.toContain("businessId");
  });
  it("retrieves the seventh or 501st same-day event by exact ID instead of the six-item summary",async()=>{
    const savedEvents=vi.fn(async(_from:string,_to:string,options?:{cityEventId?:string})=>({
      events:[],plans:[],cityCatalog:{
        available:true as const,missing:null,page:0,pageSize:1,total:1,hasMore:false,
        items:options?.cityEventId===exactId?[cityEvent]:[],
      },
    }));
    const result=await executeAgentTool("get_events",{from:date,to:date,cityEventId:exactId},
      context(savedEvents as AgentToolContext["savedEvents"]));
    expect(savedEvents).toHaveBeenCalledExactlyOnceWith(date,date,{cityEventId:exactId});
    expect(result.selectedCityEvent).toEqual(cityEvent);
    expect(result.cityEvents).toEqual([cityEvent]);
    expect(result.selectedCityEventId).toBe(exactId);
    expect(result.missing).toEqual([]);
    expect(result.searched).toBe(false);
    expect(JSON.stringify(result)).toContain("https://civic.example.org/fair");
  });
  it("never falls back to a different event when exact source identity is absent",async()=>{
    const savedEvents=vi.fn(async()=>({
      events:[],plans:[],cityCatalog:{
        available:true,missing:null,page:0,pageSize:1,total:1,hasMore:false,
        items:[{...cityEvent,id:otherId}],
      },
    }));
    const result=await executeAgentTool("get_events",
      {from:date,to:date,cityEventId:exactId},
      context(savedEvents as AgentToolContext["savedEvents"]));
    expect(result.selectedCityEvent).toBeNull();
    expect(result.missing).toEqual(["selectedCityEventNotFound"]);
    expect(result.searched).toBe(false);
  });
  it("rejects malformed city IDs and model-selected café IDs without hitting the reader",async()=>{
    const savedEvents=vi.fn();
    const ctx=context(savedEvents);
    await expect(executeAgentTool("get_events",
      {from:date,to:date,cityEventId:"not-a-uuid"},ctx)).rejects.toThrow();
    await expect(executeAgentTool("get_events",
      {from:date,to:date,cityEventId:exactId,businessId:"cafe-b"},ctx)).rejects.toThrow();
    expect(savedEvents).not.toHaveBeenCalled();
  });
});
