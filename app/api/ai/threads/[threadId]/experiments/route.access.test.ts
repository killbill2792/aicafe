import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const f=vi.hoisted(()=>({
  access:false,status:"monitored",monitorCalls:0,reportReads:0,businessReads:0,
  businessId:"11111111-1111-4111-8111-111111111111",
  ownerId:"22222222-2222-4222-8222-222222222222",
  threadId:"33333333-3333-4333-8333-333333333333",
  proposalId:"44444444-4444-4444-8444-444444444444",
}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{
    constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:async()=>({
    scope:{businessId:f.businessId,ownerUserId:f.ownerId},
    service:{getThread:async()=>({id:f.threadId})},
  }),
}));
vi.mock("@/lib/access/access.server",()=>({
  assertCafeAiAccess:async()=>{
    if(!f.access){
      const {ConversationApiError}=await import("@/lib/ai/conversations/auth.server");
      throw new ConversationApiError(403,"access_expired");
    }
  },
}));
vi.mock("@/lib/supabase/admin",()=>({
  createAdminSupabaseClient:()=>({
    from:(table:string)=>({
      select:()=>({
        eq:()=>({
          eq:()=>({
            maybeSingle:async()=>{
              if(table==="supervisor_reports")f.reportReads++;
              return {data:{status:"complete",report:{status:"complete"}},error:null};
            },
          }),
          single:async()=>{
            if(table==="businesses")f.businessReads++;
            return {data:{timezone:"America/Los_Angeles"},error:null};
          },
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:async()=>[]}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({
  supervisorLoopRegistry:{},priceExperimentCapabilityId:"alex.drink_price_experiment.v1",
}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  SupabaseLoopRepository:class{
    async load(_scope:unknown,id:string){
      if(id!==f.proposalId)throw Error("not found");
      return {id,status:f.status};
    }
  },
}));
vi.mock("@/lib/ai/supervisor/loop/engine",()=>({
  simulateLoop:vi.fn(),proposeLoop:vi.fn(),approveLoop:vi.fn(),
  commitLoop:vi.fn(),confirmManualLoop:vi.fn(),
  monitorLoop:async()=>{f.monitorCalls++;return {status:"complete"};},
  utcDateOffset:(day:string)=>day,
}));
import {POST} from "./route";
const url="http://localhost:3000/api/ai/threads/"+f.threadId+"/experiments";
const params={params:Promise.resolve({threadId:f.threadId})};
function post(body:Record<string,unknown>){
  return POST(new Request(url,{method:"POST",
    headers:{origin:"http://localhost:3000","content-type":"application/json"},
    body:JSON.stringify(body),
  }),params);
}
beforeEach(()=>{f.access=false;f.status="monitored";f.monitorCalls=0;f.reportReads=0;f.businessReads=0;});
describe("expired café can read history without creating new AI work",()=>{
  it("returns a previously stored report with expired access",async()=>{
    const r=await post({action:"report",proposalId:f.proposalId});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({report:{status:"complete"}});
    expect(f.reportReads).toBe(1);
    expect(f.monitorCalls).toBe(0);
    expect(f.businessReads).toBe(0);
  });
  it("blocks recalculating a report when no completed result exists",async()=>{
    f.status="committed";
    const r=await post({action:"report",proposalId:f.proposalId});
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({error:"access_expired"});
    expect(f.reportReads).toBe(0);expect(f.monitorCalls).toBe(0);
  });
  it("continues to block paid simulation when access has expired",async()=>{
    const r=await post({action:"simulate",productId:f.proposalId,increaseCents:50});
    expect(r.status).toBe(403);
    expect(f.reportReads).toBe(0);expect(f.monitorCalls).toBe(0);
  });
  it("allows an active café to request an uncomputed report",async()=>{
    f.access=true;f.status="committed";
    const r=await post({action:"report",proposalId:f.proposalId});
    expect(r.status).toBe(200);
    expect(f.monitorCalls).toBe(1);
    expect(f.businessReads).toBe(1);
  });
});
