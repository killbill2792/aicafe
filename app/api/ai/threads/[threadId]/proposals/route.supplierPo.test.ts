import {beforeEach,describe,it,expect,vi} from "vitest";
const f=vi.hoisted(()=>({
  businessId:"11111111-1111-4111-8111-111111111111",
  ownerUserId:"22222222-2222-4222-8222-222222222222",
  threadId:"33333333-3333-4333-8333-333333333333",
  id:"44444444-4444-4444-8444-444444444444",
  oldId:"55555555-5555-4555-8555-555555555555",replacementLookups:0,
  status:"draft",revision:1,
  failure:"stale" as "stale"|"transport"|"none",
  approvalResponseLost:false,claimResponseLost:false,
  writes:0,states:[] as string[],
}));
const effect=()=>({supplierName:"Farm A",currency:"CAD",neededBy:"2026-11-17",
  subtotalCents:450,shippingCents:null,taxCents:null,totalCents:null,
  limitations:["shipping_unknown"],lines:[]});
const row=()=>({
  id:f.id,businessId:f.businessId,ownerUserId:f.ownerUserId,threadId:f.threadId,
  capabilityId:"maya.supplier_purchase_order.v1",capabilityVersion:1,
  canonicalEffectPayload:effect(),effectHash:effectHash(effect()),
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
    async load(_scope:unknown,id:string){
      if(id===f.oldId)return {...row(),id:f.oldId,status:"rejected",revision:2};
      if(id!==f.id)throw Error("not_found");return row();
    }
    async transition(_scope:unknown,_id:string,revision:number,action:string){
      if(revision!==f.revision)throw Error("revision_conflict");
      if(action==="reject"&&(f.status==="draft"||f.status==="approved")){
        f.status="rejected";f.revision++;return row();
      }
      if(action!=="approve"||f.status!=="draft")throw Error("revision_conflict");
      // Simulates COMMITTED database transaction whose HTTP response was lost.
      f.status="approved";f.revision++;
      if(f.approvalResponseLost){
        f.approvalResponseLost=false;throw Error("connection_closed_after_approval");
      }
      return row();
    }
    async claimEffect(_scope:unknown,id:string,revision:number,authorizationKind:string){
      if(id!==f.id||revision!==f.revision||f.status!=="approved"||authorizationKind!=="click")
        throw Error("not_approved");
      f.status="executing";f.revision++;
      if(f.claimResponseLost){
        f.claimResponseLost=false;throw Error("connection_closed_after_claim");
      }
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
vi.mock("@/lib/data/proposalEdits.server",()=>({latestEditedProposalId:async()=>{
  f.replacementLookups++;return f.id;
}}));
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {GET,POST} from "./route";
const url="http://localhost:3000/api/ai/threads/"+f.threadId+"/proposals";
const params={params:Promise.resolve({threadId:f.threadId})};
const action=(name:string,revision:number=1)=>new Request(url,{
  method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3000"},
  body:JSON.stringify({action:name,proposalId:f.id,revision}),
});
beforeEach(()=>{f.status="draft";f.revision=1;f.failure="stale";f.writes=0;f.states=[];f.replacementLookups=0;
  f.approvalResponseLost=false;f.claimResponseLost=false;});
describe("Task14B owner approval: confirmed stale quote is recoverable, unknown write is not retried",()=>{
  it("two persisted original/replacement cards keep only the corrected draft approvable",async()=>{
    // The original persisted assistant block keeps oldId. A later model turn
    // saved a replacement block with id. GET is precisely what BOTH real
    // SupervisorChatComposer cards fetch after the owner reopens the thread.
    const result=await GET(new Request(url+"?ids="+f.oldId+","+f.id),params);
    expect(result.status).toBe(200);
    const data=await result.json();
    expect(data.cards).toHaveLength(2);
    expect(data.cards.map((card:{proposalId:string;state:string})=>({
      id:card.proposalId,state:card.state
    }))).toEqual([{id:f.oldId,state:"cancelled"},{id:f.id,state:"pending"}]);
    expect(data.cards.filter((card:{state:string})=>card.state==="pending")).toHaveLength(1);
    expect(f.replacementLookups).toBe(0);
    // Neither reloading nor an explicit old-card click can re-authorize it.
    const again=await GET(new Request(url+"?ids="+f.oldId),params);
    expect((await again.json()).cards[0]).toMatchObject({proposalId:f.oldId,state:"cancelled"});
    const post=new Request(url,{method:"POST",
      headers:{"content-type":"application/json",origin:"http://localhost:3000"},
      body:JSON.stringify({action:"approve",proposalId:f.oldId,revision:2})});
    const declined=await POST(post,params);
    expect(declined.status).toBe(409);
    expect(f.writes).toBe(0);
  });
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
  it("recovers an approval committed before the HTTP response was lost, with ONE authorized effect",async()=>{
    f.failure="none";f.approvalResponseLost=true;
    const first=await POST(action("approve",1),params);
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      state:"retryable",error:"supplier_po_approval_interrupted",
      proposal:{proposalId:f.id,state:"pending",revision:2},
    });
    expect(f.status).toBe("approved");expect(f.writes).toBe(0);
    const refreshed=await GET(new Request(url+"?ids="+f.id),params);
    expect((await refreshed.json()).cards[0]).toMatchObject({
      state:"pending",proposalId:f.id,revision:2,
    });
    // Owner can retry with either the original card revision (a lost
    // response) or the reloaded revision. Both use the CURRENT approved CAS.
    const recovered=await POST(action("approve",1),params);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      proposal:{proposalId:f.id,state:"applied",revision:4},
    });
    expect(f.writes).toBe(1);expect(f.states).toEqual(["verified"]);
    const replay=await POST(action("approve",2),params);
    expect((await replay.json()).state).toBe("applied");
    expect(f.writes).toBe(1);
  });
  it("lets owner CANCEL a persisted pre-claim approval, never sends a PO",async()=>{
    f.failure="none";f.approvalResponseLost=true;
    await POST(action("approve",1),params);
    const cancel=await POST(action("cancel",1),params);
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({
      state:"cancelled",proposal:{state:"cancelled",revision:3},
    });
    const again=await GET(new Request(url+"?ids="+f.id),params);
    expect((await again.json()).cards[0]).toMatchObject({state:"cancelled"});
    const prohibited=await POST(action("approve",3),params);
    expect(prohibited.status).toBe(409);
    expect(f.writes).toBe(0);
  });
  it("never reclaims an effect whose database claim might have committed",async()=>{
    f.failure="none";f.approvalResponseLost=true;
    await POST(action("approve",1),params);
    f.claimResponseLost=true;
    const uncertain=await POST(action("approve",2),params);
    expect(uncertain.status).toBe(409);
    expect(await uncertain.json()).toMatchObject({
      state:"uncertain",error:"effect_outcome_uncertain",
      // An executing effect's response is uncertain after a lost claim. The
      // explicit conflicting POST must warn the owner with an uncertain card;
      // a separate plain GET still reports the saved in-flight/applying row.
      // Neither pathway may offer an approval or repeat the supplier writer.
      proposal:{state:"uncertain",revision:3},
    });
    const visible=await GET(new Request(url+"?ids="+f.id),params);
    expect((await visible.json()).cards[0]).toMatchObject({
      state:"applying",revision:3,
    });
    const click=await POST(action("approve",2),params);
    const cancel=await POST(action("cancel",2),params);
    expect((await click.json()).state).toBe("uncertain");
    expect((await cancel.json()).state).toBe("uncertain");
    expect(f.writes).toBe(0);
  });
  it("rejects unrelated stale revisions even on recoverable approved state",async()=>{
    f.failure="none";f.approvalResponseLost=true;
    await POST(action("approve",1),params);
    const wrong=await POST(action("approve",5),params);
    expect(wrong.status).toBe(409);
    expect(f.writes).toBe(0);
    const fresh=await POST(action("approve",2),params);
    expect(fresh.status).toBe(200);
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
