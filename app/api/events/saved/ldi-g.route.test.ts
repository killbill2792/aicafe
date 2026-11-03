import {beforeEach,describe,expect,it,vi} from "vitest";

const f=vi.hoisted(()=>({
  auth:vi.fn(),access:vi.fn(),db:vi.fn(),identity:vi.fn(),
  timeline:vi.fn(),catalog:vi.fn(),coverage:vi.fn(),
}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{
    constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:f.auth,
}));
vi.mock("@/lib/ai/conversations/http.server",()=>({
  conversationError:(error:unknown)=>Response.json({error:error instanceof Error?error.message:"unknown"},
    {status:typeof error==="object"&&error!==null&&"status" in error?Number(error.status):503}),
  conversationJson:(data:unknown)=>Response.json(data),
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:f.access}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:f.db}));
vi.mock("@/lib/ai/cafeTools.server",()=>({readSupervisorCafeIdentity:f.identity}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({readOwnerProposals:vi.fn()}));
vi.mock("@/lib/ai/supervisor/loop/eventReadiness.server",()=>({
  eventReadinessCapabilityId:"alex.event_readiness.v1",
}));
vi.mock("@/lib/data/cafeEvents.server",()=>({
  readSavedEventTimeline:f.timeline,readEventChecklist:vi.fn(),
  readCityEventCatalog:f.catalog,readCityResearchCoverage:f.coverage,
}));
vi.mock("@/lib/ai/supervisor/loop/engine",()=>({
  utcDateOffset:(date:string,offset:number)=>{
    const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+offset);
    return d.toISOString().slice(0,10);
  },
}));
import {GET} from "./route";

const cafeA={businessId:"cafe-a",ownerUserId:"owner-a"};
const cafeB={businessId:"cafe-b",ownerUserId:"owner-b"};
const db={};
const cityItem={
  id:"11111111-1111-4111-8111-111111111111",name:"Official Campus Fair",kind:"community",
  startDate:"2026-11-04",endDate:"2026-11-04",startTime:null,endTime:null,
  timeSourceUrl:null,venue:"Campus",venueAddress:"1 Campus Rd",
  checkedAt:"2026-11-03T09:00:00Z",
  sources:[{url:"https://campus.example.org/events/fair",observedAt:"2026-11-03T09:00:00Z"}],
  cafeEventId:null,status:null,lastVerifiedAt:null,
};
beforeEach(()=>{
  vi.resetAllMocks();
  f.auth.mockResolvedValue({scope:cafeA});
  f.access.mockResolvedValue(undefined);
  f.db.mockResolvedValue(db);
  f.identity.mockResolvedValue({asOf:"2026-11-03",currency:"EUR"});
  f.timeline.mockResolvedValue({events:[],plans:[],cityCatalog:{available:true,items:[],page:0}});
  f.catalog.mockImplementation(async (_db:unknown,businessId:string,_from:string,_to:string,
    options:{page:number;pageSize:number})=>({
    available:true,missing:null,page:options.page,pageSize:options.pageSize,total:51,
    hasMore:options.page<2,items:[{...cityItem,cafeEventId:businessId==="cafe-b"?
      "22222222-2222-4222-8222-222222222222":null}],
  }));
  f.coverage.mockResolvedValue({status:"partial",researchedSourceWindows:4,
    successfulSourceWindows:3,failedSourceWindows:1,partialSourceWindows:0,
    unsearchedSourceWindows:0,lastCompletedAt:"2026-11-03T09:00:00Z"});
});
describe("LDI G — same authenticated saved Events API, no paid on-open research",()=>{
  it("returns the requested city month/page/filter with exact total and private café association",async()=>{
    const query="cityFrom=2026-11-01&cityTo=2026-11-30&cityPage=1&cityPageSize=25&cityKind=community&citySearch=Campus";
    const response=await GET(new Request("https://cafe.example/api/events/saved?"+query));
    expect(response.status).toBe(200);
    const result=await response.json();
    expect(f.timeline).toHaveBeenCalledWith(db,cafeA,"2026-10-20","2026-11-17");
    expect(f.catalog).toHaveBeenCalledWith(db,"cafe-a","2026-11-01","2026-11-30",{
      page:1,pageSize:25,kind:"community",search:"Campus",
    });
    expect(f.coverage).toHaveBeenCalledWith(db,"cafe-a","2026-11-01","2026-11-30");
    expect(result.cityCatalog).toMatchObject({page:1,pageSize:25,total:51,hasMore:true,
      items:[{id:cityItem.id,cafeEventId:null,sources:cityItem.sources}]});
    expect(result.cityCoverage).toMatchObject({status:"partial",failedSourceWindows:1});
    expect(result.currency).toBe("EUR");
    expect(f.access).toHaveBeenCalledWith("cafe-a");
  });
  it("does not leak one café's private link/status into another café in the same city",async()=>{
    await GET(new Request("https://cafe.example/api/events/saved?cityPage=1"));
    f.auth.mockResolvedValue({scope:cafeB});
    const b=await GET(new Request("https://cafe.example/api/events/saved?cityPage=1"));
    expect((await b.json()).cityCatalog.items[0]).toMatchObject({
      id:cityItem.id,cafeEventId:"22222222-2222-4222-8222-222222222222",
    });
    expect(f.catalog.mock.calls.map(call=>call[1])).toEqual(["cafe-a","cafe-b"]);
    expect(f.access.mock.calls.map(call=>call[0])).toEqual(["cafe-a","cafe-b"]);
  });
  it("validates pagination, calendar windows and filter inputs before any catalog query",async()=>{
    const invalid=[
      "cityPage=-1","cityPage=10001","cityPageSize=101",
      "cityFrom=bad&cityTo=2026-11-30",
      "cityFrom=2026-11-30&cityTo=2026-11-01",
      "cityFrom=2026-01-01&cityTo=2026-11-30",
      "cityKind=untrusted","citySearch="+"x".repeat(81),
    ];
    for(const query of invalid){
      const response=await GET(new Request("https://cafe.example/api/events/saved?"+query));
      expect(response.status).toBe(422);
    }
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.timeline).not.toHaveBeenCalled();
  });
  it("does not require a city catalog refresh for a normal saved Home/chat read",async()=>{
    const response=await GET(new Request("https://cafe.example/api/events/saved"));
    expect(response.status).toBe(200);
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.coverage).not.toHaveBeenCalled();
    expect(f.timeline).toHaveBeenCalledTimes(1);
  });
});
