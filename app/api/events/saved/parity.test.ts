import {beforeEach,describe,expect,it,vi} from "vitest";

const f=vi.hoisted(()=>({
  auth:vi.fn(),access:vi.fn(),db:vi.fn(),identity:vi.fn(),
  timeline:vi.fn(),checklist:vi.fn(),proposals:vi.fn(),
}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{
    constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:f.auth,
}));
vi.mock("@/lib/ai/conversations/http.server",()=>({
  conversationError:(error:unknown)=>Response.json({error:String(error)},{status:503}),
  conversationJson:(data:unknown)=>Response.json(data),
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:f.access}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:f.db}));
vi.mock("@/lib/ai/cafeTools.server",()=>({readSupervisorCafeIdentity:f.identity}));
vi.mock("@/lib/data/cafeEvents.server",()=>({
  readSavedEventTimeline:f.timeline,readEventChecklist:f.checklist,
}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({readOwnerProposals:f.proposals}));
vi.mock("@/lib/ai/supervisor/loop/eventReadiness.server",()=>({
  eventReadinessCapabilityId:"alex.event_readiness.v1",
}));
vi.mock("@/lib/ai/supervisor/loop/engine",()=>({
  utcDateOffset:(date:string,offset:number)=>{
    const value=new Date(date+"T00:00:00Z");
    value.setUTCDate(value.getUTCDate()+offset);
    return value.toISOString().slice(0,10);
  },
}));

import {GET} from "./route";
import {executeAgentTool,type AgentToolContext} from "@/lib/ai/agent/tools";

const scope={businessId:"cafe-one",ownerUserId:"owner-one"};
const report={observedDays:1,expectedDays:1,checklist:{done:2,total:3},
  days:[{date:"2026-10-16",actualCents:12500,typicalCents:10000,
    changePercent:25,baselineDays:6}]};
const timeline={
  events:[
    {id:"old",name:"Past festival",status:"cancelled",sourceUrl:"https://city.example/past",
      startDate:"2026-10-16",endDate:"2026-10-16"},
    {id:"next",name:"Neighborhood fair",status:"moved",sourceUrl:"https://city.example/fair",
      startDate:"2026-11-01",endDate:"2026-11-01"},
  ],
  plans:[{proposalId:"plan-one",threadId:"thread-one",status:"committed",revision:2,
    startDate:"2026-10-16",endDate:"2026-10-16",
    summary:"Approved festival plan",actions:[{area:"prep",action:"Extra pastries",reason:"Owner approved"}],
    expectedBusyHours:[{start:"12:00",end:"14:00"}],factsHash:"hash",
    reportStatus:"complete",report}],
};
const context=(over:Partial<AgentToolContext>={}):AgentToolContext=>({
  asOf:"2026-10-30",timezone:"America/Chicago",locale:"en",
  tools:{} as AgentToolContext["tools"],
  savedEvents:(from,to)=>f.timeline({},scope,from,to),
  ...over,
});
beforeEach(()=>{
  vi.resetAllMocks();
  f.auth.mockResolvedValue({scope});
  f.access.mockResolvedValue(undefined);
  f.identity.mockResolvedValue({asOf:"2026-10-30"});
  f.db.mockResolvedValue({});
  f.timeline.mockResolvedValue(timeline);
});

describe("Home and Supervisor saved-event parity",()=>{
  it("returns the same source links, statuses, approved plans and historical report evidence",async()=>{
    const response=await GET(new Request("https://cafe.example/api/events/saved"));
    expect(response.status).toBe(200);
    const home=await response.json();
    const chat=await executeAgentTool("get_events",
      {from:"2026-10-16",to:"2026-11-13"},context());
    expect(chat.events).toEqual(home.events);
    expect(chat.plans).toMatchObject([{
      proposalId:home.plans[0].proposalId,threadId:home.plans[0].threadId,
      status:home.plans[0].status,revision:home.plans[0].revision,
      actions:home.plans[0].actions,expectedBusyHours:home.plans[0].expectedBusyHours,
      reportStatus:home.plans[0].reportStatus,
      report:{observedDays:1,expectedDays:1,checklist:report.checklist,
        days:[{date:"2026-10-16",actualCents:12500,typicalCents:10000,
          changePercent:25,baselineDays:6}]},
    }]);
    expect(chat).toMatchObject({searched:false,omittedEvents:0,omittedPlans:0});
    expect(f.timeline).toHaveBeenNthCalledWith(1,{},scope,"2026-10-16","2026-11-13");
    expect(f.timeline).toHaveBeenNthCalledWith(2,{},scope,"2026-10-16","2026-11-13");
    expect(f.access).toHaveBeenCalledWith(scope.businessId);
  });

  it("never calls paid discovery for an old event tool name, even with saved cancellations",async()=>{
    const paidDiscovery=vi.fn(async()=>{throw new Error("paid search must not start");});
    const webSearch=vi.fn(async()=>({available:true as const,
      answer:"New event is confirmed.",sources:[{title:"City",url:"https://city.example/new"}]}));
    const ctx=context({searchNearbyEvents:paidDiscovery,webSearch});
    const saved=await executeAgentTool("get_nearby_events",
      {start_date:"2026-10-30",days:4},ctx);
    const canonical=await executeAgentTool("get_events",
      {from:"2026-10-30",to:"2026-11-02"},ctx);
    expect(saved).toEqual(canonical);
    expect(saved.events).toEqual(timeline.events); // the fixture reader is the same for either tool
    expect(paidDiscovery).not.toHaveBeenCalled();
    expect(webSearch).not.toHaveBeenCalled();

    // An owner explicitly asking for fresh public research may still use the
    // existing general web tool; it must not overwrite the saved event timeline.
    const fresh=await executeAgentTool("web_search",
      {query:"New events announced for Austin November 2026"},ctx);
    expect(fresh).toMatchObject({source:"web_search",answer:"New event is confirmed.",
      sources:[{url:"https://city.example/new"}]});
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(f.timeline).toHaveBeenCalledTimes(2);
  });
});
