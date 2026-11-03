import {describe,it,expect,vi} from "vitest";
import {executeAgentTool,agentToolDefinitions,type AgentToolContext} from "./index";
import {cafeLocationFrom} from "@/lib/data/cafeLocation.server";

const date="2026-11-03";
const snapshot={
 events:[{id:"11111111-1111-4111-8111-111111111111",name:"Public market",
   startDate:date,endDate:date,status:"found"}] as never[],
 plans:[{proposalId:"22222222-2222-4222-8222-222222222222",
   status:"draft",reportStatus:null}] as never[],
 cityCatalog:{available:true,missing:null,page:0,pageSize:50,total:1,hasMore:false,
   items:[{id:"33333333-3333-4333-8333-333333333333",name:"Public market",
     startDate:date,endDate:date}]},
 cityCoverage:{status:"partial",researchedSourceWindows:2,successfulSourceWindows:1,
   failedSourceWindows:1,partialSourceWindows:0,unsearchedSourceWindows:0,lastCompletedAt:null},
 neighborhood:[{name:"Convention center",kind:"convention",sourceUrl:"https://city.example/center",
   calendarUrl:"https://city.example/calendar",assessment:"possible",rationale:"Nearby",
   checkedAt:"2026-11-02T00:00:00Z"}],
};
const context=(over:Partial<AgentToolContext>={}):AgentToolContext=>({
 asOf:date,timezone:"America/Los_Angeles",locale:"en",
 tools:{} as AgentToolContext["tools"],...over,
});

describe("get_nearby_events compatibility: the single saved reader",()=>{
 it("publishes the backward-compatible strict schema without accepting café/location IDs",async()=>{
   const tool=agentToolDefinitions.find(t=>t.name==="get_nearby_events");
   expect(tool?.strict).toBe(true);
   expect(tool?.parameters.required).toEqual(["start_date","days"]);
   await expect(executeAgentTool("get_nearby_events",
     {start_date:null,days:null,businessId:"other"},context())).rejects.toThrow();
 });
 it("returns the EXACT same saved Events result as get_events and does not search",async()=>{
   const savedEvents=vi.fn(async()=>snapshot as never);
   const searchNearbyEvents=vi.fn(),webSearch=vi.fn();
   const ctx=context({savedEvents,searchNearbyEvents,webSearch} as unknown as AgentToolContext);
   const alias=await executeAgentTool("get_nearby_events",
     {start_date:date,days:1},ctx);
   const canonical=await executeAgentTool("get_events",{from:date,to:date},ctx);
   expect(alias).toEqual(canonical);
   expect(alias).toMatchObject({searched:false,cityEventTotal:1,
     cityResearchCoverage:{status:"partial"},events:[{name:"Public market"}],
     plans:[{status:"draft"}]});
   expect(savedEvents).toHaveBeenCalledTimes(2);
   expect(savedEvents).toHaveBeenCalledWith(date,date);
   expect(searchNearbyEvents).not.toHaveBeenCalled();
   expect(webSearch).not.toHaveBeenCalled();
 });
 it("does not turn an absent saved reader into an unsourced event or pay for discovery",async()=>{
   const searchNearbyEvents=vi.fn();
   const got=await executeAgentTool("get_nearby_events",
     {start_date:null,days:null},context({searchNearbyEvents} as unknown as AgentToolContext));
   expect(got).toMatchObject({source:"cafe_events",searched:false,
     missing:["savedEventsUnavailable"],period:{from:date,to:"2026-11-09"}});
   expect(searchNearbyEvents).not.toHaveBeenCalled();
 });
 it("supports exact past and future saved dates without a second outlook calculator",async()=>{
   const savedEvents=vi.fn(async()=>snapshot as never);
   await executeAgentTool("get_nearby_events",
     {start_date:"2025-10-31",days:10},context({savedEvents}));
   expect(savedEvents).toHaveBeenCalledWith("2025-10-31","2025-11-09");
 });
 it("preserves missing source coverage, rather than claiming no events were found",async()=>{
   const savedEvents=vi.fn(async()=>({...snapshot,events:[],plans:[],
     cityCatalog:{...snapshot.cityCatalog,total:0,items:[]}}) as never);
   const got=await executeAgentTool("get_nearby_events",
     {start_date:null,days:1},context({savedEvents}));
   expect(got.empty).toBe(true);
   expect(got.cityResearchCoverage).toMatchObject({status:"partial",failedSourceWindows:1});
   expect(got.searched).toBe(false);
 });
 it("does not hide saved-read failures behind a live web-search fallback",async()=>{
   const searchNearbyEvents=vi.fn();
   await expect(executeAgentTool("get_nearby_events",
     {start_date:null,days:1},context({
       savedEvents:async()=>{throw new Error("canonical read failed");},
       searchNearbyEvents,
     }))).rejects.toThrow("canonical read failed");
   expect(searchNearbyEvents).not.toHaveBeenCalled();
 });
});

describe("café location",()=>{
 const row={name:"Main",open_hours:null,address_line1:"12 Main St",address_line2:null,city:"Austin",
   region:"TX",postal_code:"78701",country_code:"us"};
 const typed=[{fact_key:"cafe_address",value_json:"  5 Elm Rd,  Dallas ",
   created_at:"2026-10-30T00:00:00Z",unit:null,period_scope:null}];
 it("uses the profile address first, then the owner's typed address",()=>{
   expect(cafeLocationFrom(row,typed)).toEqual({label:"12 Main St, Austin, TX 78701, US",
     city:"Austin",region:"TX",postalCode:"78701",countryCode:"US",source:"profile"});
   expect(cafeLocationFrom({...row,city:null,postal_code:null},typed)).toEqual({
     label:"5 Elm Rd, Dallas",city:null,region:null,postalCode:null,
     countryCode:"US",source:"owner"});
   expect(cafeLocationFrom(null,[])).toBeNull();
 });
 it("keeps the localized saved-owner-fact question tool unchanged",async()=>{
   const c=context({resolveState:{asked:false} as AgentToolContext["resolveState"]});
   const r=await executeAgentTool("ask_owner",{question:"Where is your café?",kind:"facts",
     options:[],allowOther:false,fields:[{key:"cafe_address",label:"Address",inputType:"text",
       units:[],defaultUnit:"",choices:null}]},{...c,locale:"es"});
   expect(r.missing).toEqual([]);
   expect(r.fields).toEqual([expect.objectContaining({key:"cafe_address",
     label:"la dirección de tu café (calle, ciudad y código postal)"})]);
 });
});
