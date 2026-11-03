import {describe,expect,it,vi} from "vitest";
import {executeAgentTool,type AgentToolContext} from "./index";
import type {SavedEventTimeline} from "@/lib/data/cafeEvents.server";

const cityId="11111111-1111-4111-8111-111111111111";
const selected={
  id:cityId,name:"Convention at Civic Center",kind:"conference",
  startDate:"2026-11-04",endDate:"2026-11-04",startTime:"09:00",endTime:"18:00",
  timeSourceUrl:"https://city.example.org/meeting-hours",
  venue:"Civic Center",venueAddress:"1 Main St, Metro",
  checkedAt:"2026-11-03T10:00:00Z",
  sources:[{url:"https://city.example.org/convention",observedAt:"2026-11-03T10:00:00Z"}],
  cafeEventId:null,status:null,lastVerifiedAt:null,
};
const timeline=(items:typeof selected[]):SavedEventTimeline=>({
  events:[],plans:[],cityCatalog:{
    available:true,missing:null,page:0,pageSize:1,total:items.length,
    hasMore:false,items,
  },
});
const context=(reader:NonNullable<AgentToolContext["savedEvents"]>):AgentToolContext=>({
  asOf:"2026-11-03",timezone:"America/Los_Angeles",locale:"en",
  tools:{} as AgentToolContext["tools"],savedEvents:reader,
});

describe("LDI G — selected unlinked city event in the one saved chat reader",()=>{
  it("retrieves the exact selected event beyond the six-item default, including all cited facts",async()=>{
    // A city can have 600 other events; the reader scopes by ID before paging.
    const savedEvents=vi.fn(async (_from:string,_to:string,
      options?:{cityEventId?:string})=>options?.cityEventId===cityId?
      timeline([selected]):timeline([]));
    const result=await executeAgentTool("get_events",{
      from:"2026-11-04",to:"2026-11-04",cityEventId:cityId,
    },context(savedEvents));
    expect(savedEvents).toHaveBeenCalledWith(
      "2026-11-04","2026-11-04",{cityEventId:cityId});
    expect(result.selectedCityEvent).toMatchObject({
      id:cityId,name:selected.name,venue:selected.venue,
      timeSourceUrl:selected.timeSourceUrl,sources:selected.sources,
      checkedAt:selected.checkedAt,status:null,
    });
    expect(result.cityEventTotal).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.searched).toBe(false);
  });
  it("does not substitute a different city's event when the exact city ID is absent",async()=>{
    const savedEvents=vi.fn(async()=>timeline([]));
    const result=await executeAgentTool("get_events",{
      from:"2026-11-04",to:"2026-11-04",cityEventId:cityId,
    },context(savedEvents));
    expect(result.selectedCityEvent).toBeNull();
    expect(result.missing).toEqual(["selectedCityEventNotFound"]);
    expect(result.cityEvents).toEqual([]);
    expect(result.searched).toBe(false);
  });
  it("preserves the original two-argument read and tool budget for ordinary saved events",async()=>{
    const savedEvents=vi.fn(async()=>timeline([]));
    const result=await executeAgentTool("get_events",{
      from:"2026-11-04",to:"2026-11-04",
    },context(savedEvents));
    expect(savedEvents).toHaveBeenCalledWith("2026-11-04","2026-11-04");
    expect(result).not.toHaveProperty("selectedCityEventId");
  });
});
