import {describe,it,expect,vi,beforeEach} from "vitest";
const f=vi.hoisted(()=>({
  scope:{businessId:"11111111-1111-4111-8111-111111111111",
    ownerUserId:"22222222-2222-4222-8222-222222222222"},
  threadId:"33333333-3333-4333-8333-333333333333",
  id:"44444444-4444-4444-8444-444444444444",
  productId:"55555555-5555-4555-8555-555555555555",
  revision:1,status:"draft",current:450,saves:0,ownerAllowed:true,
  created:0,createdPrice:0,
}));
const effect=()=>({productId:f.productId,productName:"Latte",oldPriceCents:450,
  newPriceCents:500,currency:"USD"});
const row=()=>({
  id:f.id,businessId:f.scope.businessId,ownerUserId:f.scope.ownerUserId,threadId:f.threadId,
  capabilityId:"alex.menu_price_change.v1",capabilityVersion:1,canonicalEffectPayload:effect(),
  effectHash:effectHash(effect()),baseline:{source:"menu_items",status:"actual"},monitorSpec:{durationDays:7,metricScope:f.productId},
  revision:f.revision,status:f.status,locale:"en",monitoringStartDate:null,createdAt:"2026-10-22T00:00:00Z",
});
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{constructor(public status:number,public code:string){super(code);}},
  authenticatedConversationContext:async()=>({
    scope:f.scope,service:{getThread:async(id:string)=>{
      if(id!==f.threadId||!f.ownerAllowed)throw Error("not found");
      return {id};
    }},
  }),
}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  SupabaseLoopRepository:class{
    async load(_scope:unknown,id:string){
      if(id!==f.id||!f.ownerAllowed)throw Error("not found");
      return row();
    }
    async create(_scope:unknown,_key:string,p:{canonicalEffectPayload:{newPriceCents:number}}){
      f.created++;f.createdPrice=p.canonicalEffectPayload.newPriceCents;
      return {...row(),id:"66666666-6666-4666-8666-666666666666",status:"draft",revision:1,
        canonicalEffectPayload:p.canonicalEffectPayload,baseline:{editedByOwner:true}};
    }
    async transition(_scope:unknown,_id:string,rev:number,action:string){
      if(rev!==f.revision)throw Error("conflict");
      if(action==="reject"&&f.status==="draft"){f.status="rejected";f.revision++;return row();}
      if(action==="approve"&&f.status==="draft"){f.status="approved";f.revision++;return row();}
      if(action==="claim_commit"&&f.status==="approved"){f.status="executing";f.revision++;return row();}
      if(action==="committed"&&f.status==="executing"){f.status="committed";f.revision++;return row();}
      throw Error("invalid transition");
    }
  },
}));
vi.mock("@/lib/ai/supervisor/loop/menuPriceChange.server",()=>({
  menuPriceChangeCapabilityId:"alex.menu_price_change.v1",
  StaleProposalError:class extends Error{},
}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({
  supervisorLoopRegistry:{get:()=>({
    version:1,parseEffect:(raw:unknown)=>raw,
    simulate:async(_scope:unknown,input:{productId:string;newPriceCents:number})=>({
      effect:{...effect(),newPriceCents:input.newPriceCents},baseline:{source:"menu_items",status:"actual"},
      monitorSpec:{durationDays:7,metricScope:input.productId}}),
    commit:async()=>{f.saves++;f.current=500;return {status:"verified",evidenceSource:"menu_price_history"};},
  })},
}));
vi.mock("@/lib/data/proposalPrices.server",()=>({ownerMenuPrice:async()=>f.current}));
vi.mock("@/lib/data/proposalEdits.server",()=>({latestEditedProposalId:async()=>null}));
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {GET,POST} from "./route";
const url="http://localhost:3000/api/ai/threads/"+f.threadId+"/proposals";
const params={params:Promise.resolve({threadId:f.threadId})};
const request=(action:string,revision=1,withOrigin=true)=>new Request(url,{
  method:"POST",headers:{"content-type":"application/json",...(withOrigin?{origin:"http://localhost:3000"}:{})},
  body:JSON.stringify({action,proposalId:f.id,revision}),
});
beforeEach(()=>{f.revision=1;f.status="draft";f.current=450;f.saves=0;f.ownerAllowed=true;f.created=0;f.createdPrice=0;});
describe("owner-scoped price approval actions",()=>{
  it("approves and commits in one authenticated request",async()=>{
    const response=await POST(request("approve"),params);
    expect(response.status).toBe(200);
    expect((await response.json()).proposal.state).toBe("applied");
    expect(f.status).toBe("committed");expect(f.saves).toBe(1);
  });
  it("concurrent clicks consume a single approval",async()=>{
    const [a,b]=await Promise.all([POST(request("approve"),params),POST(request("approve"),params)]);
    expect([a.status,b.status].sort()).toEqual([200,409]);
    expect(f.saves).toBe(1);
  });
  it("cancels and never executes",async()=>{
    const response=await POST(request("cancel"),params);
    expect((await response.json()).proposal.state).toBe("cancelled");
    expect(f.saves).toBe(0);
  });
  it("stale price blocks approval and all writes",async()=>{
    f.current=480;
    const response=await POST(request("approve"),params);
    expect(response.status).toBe(409);
    expect((await response.json()).state).toBe("stale");
    expect(f.saves).toBe(0);expect(f.status).toBe("draft");
  });
  it("revision mismatch does not approve",async()=>{
    const response=await POST(request("approve",2),params);
    expect(response.status).toBe(409);expect((await response.json()).state).toBe("conflict");
    expect(f.saves).toBe(0);
  });
  it("editing rejects the old revision and creates a new immutable draft",async()=>{
    const req=new Request(url,{method:"POST",
      headers:{"origin":"http://localhost:3000","content-type":"application/json"},
      body:JSON.stringify({action:"edit",proposalId:f.id,revision:1,newPriceCents:575})});
    const response=await POST(req,params);
    expect(response.status).toBe(200);
    const result=await response.json();
    expect(result.replaced.state).toBe("edited");
    expect(result.proposal).toMatchObject({state:"pending",newPriceCents:575,editedByOwner:true});
    expect(f.status).toBe("rejected");
    expect(f.created).toBe(1);expect(f.createdPrice).toBe(575);expect(f.saves).toBe(0);
  });
  it("unchanged edit validation leaves the original proposal actionable",async()=>{
    const response=await POST(new Request(url,{method:"POST",
      headers:{"origin":"http://localhost:3000","content-type":"application/json"},
      body:JSON.stringify({action:"edit",proposalId:f.id,revision:1,newPriceCents:450})}),params);
    expect(response.status).toBe(422);
    expect((await response.json()).state).toBe("unchanged");
    expect(f.status).toBe("draft");
    expect(f.created).toBe(0);
    expect(f.saves).toBe(0);
  });
  it("does not report an executing claim as failed before the save completes",async()=>{
    f.status="executing";f.revision=3;
    const get=()=>GET(new Request(url+"?ids="+f.id),params);
    const during=await get();
    expect(during.status).toBe(200);
    expect((await during.json()).cards[0].state).toBe("applying");
    f.current=500;
    const after=await get();
    expect((await after.json()).cards[0].state).toBe("applied");
  });
  it("requires owner scope and same-origin",async()=>{
    expect((await POST(request("approve",1,false),params)).status).toBe(403);
    f.ownerAllowed=false;
    expect((await POST(request("approve"),params)).status).not.toBe(200);
    expect(f.saves).toBe(0);
  });
});
