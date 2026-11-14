import {beforeEach,describe,it,expect,vi} from "vitest";
const f=vi.hoisted(()=>({
  businessId:"11111111-1111-4111-8111-111111111111",
  ownerUserId:"22222222-2222-4222-8222-222222222222",
  threadId:"33333333-3333-4333-8333-333333333333",
  id:"44444444-4444-4444-8444-444444444444",
  status:"draft",revision:1,
  failure:"stale" as "stale"|"transport"|"none",
  writes:0,states:[] as string[],
}));
const effect=()=>({supplierName:"Farm A",currency:"CAD",neededBy:"2026-11-17",
  subtotalCents:450,shippingCents:null,taxCents:null,totalCents:null,
  limitations:["shipping_unknown"],lines:[]});
const row=()=>({
  id:f.id,businessId:f.businessId,ownerUserId:f.ownerUserId,threadId:f.threadId,
  capabilityId:"maya.supplier_purchase_order.v1",capabilityVersion:1,
  canonicalEffectPayload:effect(),effectHash:"test-effect-hash",
  baseline:{},monitorSpec:{durationDays:1,metricScope:"supplier_purchase_order"},
  revision:f.revision,status:f.status,locale:"en",monitoringStartDate:null,
  createdAt:"2026-11-14T00:00:00Z",
});
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{
   constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:async()=>({
   scope:{businessId:f.businessId,ownerUserId:f.ownerUserId},
   service:{getThread:async(id:string)=>{if(id!==f.threadId)throw Error("not_found");return {id};}},
  }),
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:async()=>{}}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  SupabaseLoopRepository:class{
    async load(_scope:unknown,id:string){if(id!==f.id)throw Error("not_found");return row();}
    async transition(_scope:unknown,_id:string,revision:number,action:string){
      if(revision!==f.revision||action!=="approve"||f.status!=="draft")throw Error("revision_conflict");
      f.status="approved";f.revision++;return row();
    }
    async claimEffect(_scope:unknown,id:string,revision:number,authorizationKind:string){
      if(id!==f.id||revision!==f.revision||f.status!=="approved"||authorizationKind!=="click")
        throw Error("not_approved");
      f.status="executing";f.revision++;
      return {proposal:row(),attemptKey:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        businessDate:"2026-11-14",authorizationKind:"click"};
    }
    async finishEffect(_scope:unknown,_claim:unknown,revision:number,state:string){
      if(f.status!=="executing"||revision!==f.revision)throw Error("attempt_conflict");
      f.states.push(state);
      if(state==="stale"){f.status="stale";f.revision++;}
      if(state==="verified"){f.status="committed";f.revision++;}
      return row();
    }
    async effectAttempt(){return {state:f.states.at(-1)??"executing",
      authorizationKind:"click",businessDate:"2026-11-14"};}
  },
}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({
  priceExperimentCapabilityId:"alex.drink_price_experiment.v1",
  supervisorLoopRegistry:{get:()=>({
    version:1,parseEffect:(raw:unknown)=>raw,
    dependencyScope:()=>({kind:"supplier_purchase_order",supplierName:"Farm A"}),
    commit:async()=>{
      f.writes++;
      if(f.failure==="stale")throw Object.assign(new Error("supplier_quote_superseded"),
        {name:"StaleProposalError"});
      if(f.failure==="transport")throw new Error("provider_result_unknown");
      return {status:"verified",evidenceSource:"purchase_orders"};
    },
  })},
}));
vi.mock("@/lib/ai/supervisor/loop/menuPriceChange.server",()=>({
  menuPriceChangeCapabilityId:"alex.menu_price_change.v1",
  StaleProposalError:class extends Error{},
}));
vi.mock("@/lib/data/proposalPrices.server",()=>({ownerMenuPrice:async()=>null}));
vi.mock("@/lib/data/proposalEdits.server",()=>({latestEditedProposalId:async()=>null}));
import {GET,POST} from "./route";
const url="http://localhost:3000/api/ai/threads/"+f.threadId+"/proposals";
const params={params:Promise.resolve({threadId:f.threadId})};
const action=(name:string,revision:number=1)=>new Request(url,{
  method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3000"},
  body:JSON.stringify({action:name,proposalId:f.id,revision}),
});
beforeEach(()=>{f.status="draft";f.revision=1;f.failure="stale";f.writes=0;f.states=[];});
describe("Task14B owner approval: confirmed stale quote is recoverable, unknown write is not retried",()=>{
  it("returns terminal stale to the owner after a confirmed database rejection",async()=>{
    const response=await POST(action("approve"),params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      state:"stale",error:"supplier_po_evidence_stale",
      proposal:{proposalId:f.id,state:"stale",revision:4},
    });
    expect(f.states).toEqual(["stale"]);
    expect(f.writes).toBe(1);
    const read=await GET(new Request(url+"?ids="+f.id),params);
    expect((await read.json()).cards[0]).toMatchObject({proposalId:f.id,state:"stale"});
    const retry=await POST(action("approve",4),params);
    expect((await retry.json()).state).toBe("stale");
    expect(f.writes).toBe(1);
  });
  it("retains an unknown transport outcome as uncertain and blocks another PO write",async()=>{
    f.failure="transport";
    const response=await POST(action("approve"),params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      state:"uncertain",error:"effect_outcome_uncertain",
      proposal:{proposalId:f.id,state:"uncertain"},
    });
    expect(f.states).toEqual(["uncertain"]);
    const retry=await POST(action("approve",3),params);
    expect((await retry.json()).state).toBe("uncertain");
    expect(f.writes).toBe(1);
  });
});
