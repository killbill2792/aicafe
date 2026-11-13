import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const f=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({rpc:f.rpc,from:f.from})}));
vi.mock("./goal.server",()=>({goalCapabilityId:"leo.goal.v1"}));
import {SupervisorEffectGateway} from "./effectGateway.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const id="44444444-4444-4444-8444-444444444444";
const row=(status:"executing"|"committed"|"manual_pending"|"stale"="executing")=>({
 id,business_id:scope.businessId,owner_user_id:scope.ownerUserId,thread_id:scope.threadId,
 capability_id:"leo.goal.v1",capability_version:1,canonical_effect_payload:{metric:"orders"},
 effect_hash:"a".repeat(64),baseline:{},monitor_spec:{durationDays:1,metricScope:"goal"},
 status,revision:3,locale:"en",monitoring_start_date:null,created_at:"2026-10-01T00:00:00Z",
});
beforeEach(()=>{vi.clearAllMocks();});
describe("single Supervisor effect gateway",()=>{
 it("claims a scoped immutable proposal through the gateway RPC, not the legacy transition",async()=>{
  f.rpc.mockResolvedValue({data:{proposal:row(),attempt_key:"55555555-5555-4555-8555-555555555555",
   business_date:"2026-10-23",authorization_kind:"click"},error:null});
  const claim=await new SupervisorEffectGateway().claim(scope,id,2,"click");
  expect(claim).toMatchObject({attemptKey:"55555555-5555-4555-8555-555555555555",
   businessDate:"2026-10-23",authorizationKind:"click",proposal:{status:"executing",revision:3}});
  expect(f.rpc).toHaveBeenCalledWith("supervisor_claim_effect",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:id,p_revision:2,p_authorization_kind:"click"});
  expect(f.rpc.mock.calls.some(([name])=>name==="supervisor_transition_proposal")).toBe(false);
 });
 it("claims only an exact saved owner purchase message via a distinct authorization RPC",async()=>{
  f.rpc.mockResolvedValueOnce({data:{proposal:{...row(),capability_id:"maya.inventory_purchase.v1"},
   attempt_key:"55555555-5555-4555-8555-555555555555",
   business_date:"2026-10-23",authorization_kind:"owner_message"},error:null});
  const ownerMessageId="77777777-7777-4777-8777-777777777777";
  const claim=await new SupervisorEffectGateway().claim(scope,id,1,"owner_message",ownerMessageId);
  expect(claim.authorizationKind).toBe("owner_message");
  expect(f.rpc).toHaveBeenCalledWith("supervisor_claim_owner_purchase_effect",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:id,p_revision:1,p_owner_message_id:ownerMessageId
  });
  await expect(new SupervisorEffectGateway().claim(scope,id,1,"owner_message")).rejects.toThrow("owner_message_id_required");
 });
 it("rejects a gateway response whose proposal escapes the owner or thread scope",async()=>{
  f.rpc.mockResolvedValue({data:{proposal:{...row(),owner_user_id:"99999999-9999-4999-8999-999999999999"},
   attempt_key:"55555555-5555-4555-8555-555555555555",business_date:"2026-10-23",
   authorization_kind:"click"},error:null});
  await expect(new SupervisorEffectGateway().claim(scope,id,2,"click")).rejects.toThrow("invalid scoped claim");
 });
 function scopedRead(proposal:{id:string;effect_hash:string}|null,
  attempt:{state:string;authorization_kind:string;business_date:string}|null){
  const calls:{table:string;filters:Array<[string,unknown]>}[]=[];
  f.from.mockImplementation((table:string)=>{
   const query={table,filters:[] as Array<[string,unknown]>};
   calls.push(query);
   const chain={
    select:vi.fn(()=>chain),
    eq:vi.fn((field:string,value:unknown)=>{query.filters.push([field,value]);return chain;}),
    order:vi.fn(()=>chain),limit:vi.fn(()=>chain),
    maybeSingle:vi.fn(async()=>({data:table==="supervisor_proposals"?proposal:attempt,error:null})),
   };
   return chain;
  });
  return calls;
 }
 it("reads an executing attempt only after verifying the immutable owner/café/thread proposal",async()=>{
  const calls=scopedRead({id,effect_hash:"a".repeat(64)},
   {state:"executing",authorization_kind:"mandate",business_date:"2026-10-23"});
  const result=await new SupervisorEffectGateway().readAttempt(scope,id);
  expect(result).toEqual({state:"executing",authorizationKind:"mandate",businessDate:"2026-10-23"});
  expect(calls.map(x=>x.table)).toEqual(["supervisor_proposals","supervisor_effect_attempts"]);
  expect(calls[0].filters).toEqual([
   ["business_id",scope.businessId],["owner_user_id",scope.ownerUserId],
   ["thread_id",scope.threadId],["id",id]]);
  expect(calls[1].filters).toEqual([
   ["business_id",scope.businessId],["proposal_id",id],["effect_hash","a".repeat(64)]]);
  expect(calls[1].filters.some(([key])=>key==="owner_user_id"||key==="thread_id")).toBe(false);
 });
 it("does not read an attempt if the proposal is from another owner or thread",async()=>{
  const calls=scopedRead(null,{state:"executing",authorization_kind:"click",business_date:"2026-10-23"});
  expect(await new SupervisorEffectGateway().readAttempt(scope,id)).toBeNull();
  expect(calls.map(x=>x.table)).toEqual(["supervisor_proposals"]);
 });
 it("reconciles only through the scoped service RPC; no capability commit is invoked",async()=>{
   f.rpc.mockResolvedValueOnce({data:row("committed"),error:null});
   const result=await new SupervisorEffectGateway().reconcile(scope,id,3);
   expect(result.status).toBe("committed");
   expect(f.rpc).toHaveBeenCalledWith("supervisor_reconcile_effect_attempt",{
     p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
     p_thread_id:scope.threadId,p_proposal_id:id,p_revision:3});
 });
 it("rejects a recovered proposal from a different owner or thread",async()=>{
   f.rpc.mockResolvedValueOnce({data:{...row("committed"),thread_id:"99999999-9999-4999-8999-999999999999"},error:null});
   await expect(new SupervisorEffectGateway().reconcile(scope,id,3)).rejects.toThrow("invalid scoped proposal");
 });
 it("marks ambiguous provider outcomes uncertain without a next status or receipt",async()=>{
  f.rpc.mockResolvedValue({data:row("executing"),error:null});
  const claim={proposal:{id} as never,attemptKey:"55555555-5555-4555-8555-555555555555",
   businessDate:"2026-10-23",authorizationKind:"click" as const};
  await new SupervisorEffectGateway().finish(scope,claim,3,"uncertain");
  expect(f.rpc).toHaveBeenCalledWith("supervisor_finish_effect_attempt",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,p_thread_id:scope.threadId,
   p_proposal_id:id,p_attempt_key:claim.attemptKey,p_revision:3,p_state:"uncertain",
   p_next_status:null,p_monitoring_start_date:null});
 });
 it("keeps staff source CAS inside the same gateway transaction",async()=>{
  f.rpc.mockResolvedValue({data:{state:"applied",proposal:row("committed"),
   attempt_key:"55555555-5555-4555-8555-555555555555"},error:null});
  const result=await new SupervisorEffectGateway().commitStaff(scope,id,2);
  expect(result.state).toBe("applied");
  expect(f.rpc).toHaveBeenCalledWith("supervisor_gateway_commit_staff",{
   p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
   p_thread_id:scope.threadId,p_proposal_id:id,p_revision:2});
 });
});
