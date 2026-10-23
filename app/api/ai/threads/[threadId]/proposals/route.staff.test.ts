import {describe,it,expect,vi,beforeEach} from "vitest";
const f=vi.hoisted(()=>({
 business:"11111111-1111-4111-8111-111111111111",owner:"22222222-2222-4222-8222-222222222222",
 thread:"33333333-3333-4333-8333-333333333333",id:"44444444-4444-4444-8444-444444444444",
 status:"draft",revision:1,saved:0,approved:0,cancelled:0,stale:false,deny:false,
 token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
}));
const effect={operation:"propose_rule_change",expectedToken:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
 preview:[{label:"prep_minutes_before_open",before:"0",after:"30"}],
 payload:{rule:"prep_minutes_before_open",boolean_value:null,number_value:30}};
const row=()=>({id:f.id,businessId:f.business,ownerUserId:f.owner,threadId:f.thread,
 capabilityId:"olivia.staff_propose_rule_change.v1",capabilityVersion:1,
 canonicalEffectPayload:effect,effectHash:"a".repeat(64),baseline:{},
 monitorSpec:{durationDays:1,metricScope:"staff"},status:f.status,revision:f.revision,
 locale:"en",monitoringStartDate:null,createdAt:"2026-10-23T00:00:00Z"});
vi.mock("@/lib/ai/conversations/auth.server",()=>({
 ConversationApiError:class extends Error{constructor(public status:number,public code:string){super(code);}},
 authenticatedConversationContext:async()=>({scope:{businessId:f.business,ownerUserId:f.owner},
  service:{getThread:async()=>{if(f.deny)throw Error("forbidden");}}}),
}));
vi.mock("@/lib/ai/supervisor/loop/staffProposals.server",()=>({
 isStaffCapabilityId:(id:string)=>id.startsWith("olivia.staff_"),
 readStaffProposalToken:async()=>f.token,
}));
vi.mock("@/lib/data/proposalPrices.server",()=>({ownerMenuPrice:async()=>450}));
vi.mock("@/lib/data/proposalEdits.server",()=>({latestEditedProposalId:async()=>null}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({
 supervisorLoopRegistry:{get:()=>({parseEffect:(x:unknown)=>x})},
}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
 SupabaseLoopRepository:class {
  async load(scope:{businessId:string;ownerUserId:string;threadId:string},id:string){
   if(f.deny||id!==f.id||scope.businessId!==f.business||scope.ownerUserId!==f.owner||scope.threadId!==f.thread)
    throw Error("not found");
   return row();
  }
  async transition(_scope:unknown,_id:string,revision:number,action:string){
   if(revision!==f.revision)throw Error("revision conflict");
   if(action==="approve"&&f.status==="draft"){f.status="approved";f.revision++;f.approved++;return row();}
   if(action==="reject"&&f.status==="draft"){f.status="rejected";f.revision++;f.cancelled++;return row();}
   throw Error("invalid transition");
  }
  async commitStaff(_scope:unknown,_id:string,revision:number){
   if(revision!==f.revision||f.status!=="approved")throw Error("revision conflict");
   if(f.stale||f.token!==effect.expectedToken){f.status="stale";f.revision++;return {state:"stale",proposal:row()};}
   f.status="committed";f.revision+=2;f.saved++;
   return {state:"applied",proposal:row()};
  }
 } }));
import {POST,GET} from "./route";
const path="http://localhost:3000/api/ai/threads/"+f.thread+"/proposals";
const params={params:Promise.resolve({threadId:f.thread})};
const post=(action:string,revision=1)=>new Request(path,{method:"POST",
 headers:{"content-type":"application/json",origin:"http://localhost:3000"},
 body:JSON.stringify({action,proposalId:f.id,revision})});
beforeEach(()=>{f.status="draft";f.revision=1;f.saved=0;f.approved=0;f.cancelled=0;f.stale=false;f.deny=false;f.token=effect.expectedToken;});
describe("staff approval through shared Supervisor ledger",()=>{
 it("previews before/after without a write, then applies exactly once",async()=>{
  const preview=await GET(new Request(path+"?ids="+f.id),params);
  expect(preview.status).toBe(200);
  const card=(await preview.json()).cards[0];
  expect(card.preview).toEqual(effect.preview);
  expect(f.saved).toBe(0);
  const approved=await POST(post("approve"),params);
  expect(approved.status).toBe(200);
  expect((await approved.json()).proposal.state).toBe("applied");
  expect(f.approved).toBe(1);expect(f.saved).toBe(1);
 });
 it("second click cannot apply or duplicate an audit entry",async()=>{
  const results=await Promise.all([POST(post("approve"),params),POST(post("approve"),params)]);
  // Both responses may reconcile to applied; the invariant is ONE durable write.
  expect(results.map(x=>x.status).sort()).toEqual([200,200]);
  expect(f.saved).toBe(1);expect(f.approved).toBe(1);
 });
 it("rejects stale data and never writes any staff effect",async()=>{
  f.token="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const response=await POST(post("approve"),params);
  expect(response.status).toBe(409);
  expect(f.saved).toBe(0);
  expect((await response.json()).state).toBe("stale");
 });
 it("decline cancels without an approval audit or staff mutation",async()=>{
  const response=await POST(post("cancel"),params);
  expect(response.status).toBe(200);
  expect(f.status).toBe("rejected");expect(f.saved).toBe(0);expect(f.approved).toBe(0);
 });
 it("scopes reads and approval to tenant owner and thread",async()=>{
  f.deny=true;
  const response=await POST(post("approve"),params);
  expect(response.status).not.toBe(200);
  expect(f.saved).toBe(0);expect(f.approved).toBe(0);
 });
});