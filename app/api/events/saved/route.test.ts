import {beforeEach,describe,expect,it,vi} from "vitest";

const f=vi.hoisted(()=>({
  auth:vi.fn(),access:vi.fn(),db:vi.fn(),identity:vi.fn(),timeline:vi.fn(),
  checklist:vi.fn(),proposals:vi.fn(),upsert:vi.fn(),origin:vi.fn(),
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
  conversationJson:(data:unknown,status=200)=>Response.json(data,{status}),
  parseInput:(schema:{parse:(v:unknown)=>unknown},value:unknown)=>schema.parse(value),
  readBoundedJson:(request:Request)=>request.json(),
  requireSameOrigin:f.origin,
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
    const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+offset);
    return d.toISOString().slice(0,10);
  },
}));
import {GET,POST} from "./route";

const owner={businessId:"cafe",ownerUserId:"owner"};
const proposalId="f24a6a1b-b86e-4dd7-b9b9-0560ad168b0d";
beforeEach(()=>{
  vi.resetAllMocks();
  f.auth.mockResolvedValue({scope:owner});
  f.access.mockResolvedValue(undefined);
  f.identity.mockResolvedValue({asOf:"2026-10-30"});
  f.timeline.mockResolvedValue({events:[],plans:[]});
  f.checklist.mockResolvedValue([{actionIndex:0,state:"done"}]);
  f.proposals.mockResolvedValue([{status:"committed",canonical_effect_payload:{actions:[{action:"Prepare"}]}}]);
  f.upsert.mockResolvedValue({error:null});
  f.db.mockResolvedValue({from:()=>({upsert:f.upsert})});
});
describe("saved event timeline API",()=>{
  it("reads only the owner-scoped PR 3 timeline, without calling a search",async()=>{
    const response=await GET(new Request("https://cafe.example/api/events/saved"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({today:"2026-10-30",events:[],plans:[]});
    expect(f.timeline).toHaveBeenCalledWith(expect.anything(),owner,"2026-10-16","2026-11-13");
    expect(f.access).toHaveBeenCalledWith("cafe");
  });
  it("scopes checklist reads to an owned event-readiness proposal",async()=>{
    const response=await GET(new Request("https://cafe.example/api/events/saved?proposalId="+proposalId));
    expect(response.status).toBe(200);
    expect(f.proposals).toHaveBeenCalledWith(expect.anything(),owner,
      {id:proposalId,capabilityId:"alex.event_readiness.v1",limit:1});
    expect(await response.json()).toEqual({ticks:[{actionIndex:0,state:"done"}]});
  });
  it("accepts a tick only on an approved owner plan and records the real owner",async()=>{
    const response=await POST(new Request("https://cafe.example/api/events/saved",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({proposalId,actionIndex:0,state:"done"}),
    }));
    expect(response.status).toBe(200);
    expect(f.origin).toHaveBeenCalledTimes(1);
    expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({
      business_id:"cafe",proposal_id:proposalId,updated_by:"owner",action_index:0,state:"done",
    }),{onConflict:"business_id,proposal_id,action_index"});
  });
  it("rejects unapproved proposals and out-of-range actions without writing",async()=>{
    f.proposals.mockResolvedValue([{status:"draft",canonical_effect_payload:{actions:[{}]}}]);
    const request=()=>new Request("https://cafe.example/api/events/saved",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({proposalId,actionIndex:0,state:"done"}),
    });
    expect((await POST(request())).status).toBe(409);
    f.proposals.mockResolvedValue([{status:"committed",canonical_effect_payload:{actions:[{}]}}]);
    const invalid=await POST(new Request("https://cafe.example/api/events/saved",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({proposalId,actionIndex:2,state:"done"}),
    }));
    expect(invalid.status).toBe(422);
    expect(f.upsert).not.toHaveBeenCalled();
  });
});
