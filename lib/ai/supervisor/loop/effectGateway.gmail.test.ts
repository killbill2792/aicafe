import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),reconcile:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({rpc:state.rpc,from:state.from})}));
vi.mock("./goal.server",()=>({goalCapabilityId:"leo.goal.v1",goalMandatePolicy:{limitValue:5}}));
vi.mock("./gmail.server",()=>({gmailCapabilityId:"alex.gmail_effect.v1",
 gmailEffectSchema:{parse:(value:unknown)=>value}}));
vi.mock("@/lib/connectors/gmail/provider.server",()=>({reconcileGmailReceipt:state.reconcile}));
import {SupervisorEffectGateway} from "./effectGateway.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const id="44444444-4444-4444-8444-444444444444",attempt="55555555-5555-4555-8555-555555555555";
const payload={accountId:"66666666-6666-4666-8666-666666666666",generation:3,
 from:"owner@example.com",operation:"send"};
const row=(status="executing")=>({
 id,business_id:scope.businessId,owner_user_id:scope.ownerUserId,thread_id:scope.threadId,
 capability_id:"alex.gmail_effect.v1",capability_version:1,canonical_effect_payload:payload,
 effect_hash:"a".repeat(64),baseline:{},monitor_spec:{durationDays:1,metricScope:"gmail"},
 status,revision:3,locale:"en",monitoring_start_date:null,created_at:"2026-11-12T01:00:00Z"
});
function mockFrom(proposal:unknown,attemptRecord:unknown){
  const selections:Array<{table:string;filters:Array<[string,unknown]>}>=[];
  state.from.mockImplementation((table:string)=>{
    const q={table,filters:[] as Array<[string,unknown]>};selections.push(q);
    const chain={select:vi.fn(()=>chain),
      eq:vi.fn((key:string,value:unknown)=>{q.filters.push([key,value]);return chain;}),
      maybeSingle:vi.fn(async()=>({data:table==="supervisor_proposals"?proposal:attemptRecord,error:null}))};
    return chain;
  });
  return selections;
}
beforeEach(()=>{vi.clearAllMocks();});
describe("Gmail provider-specific receipt gateway",()=>{
 it("finishes Gmail only using receipt-validated SQL, not the generic local receipt RPC",async()=>{
   state.rpc.mockResolvedValue({data:row("committed"),error:null});
   const claim={proposal:{id,capabilityId:"alex.gmail_effect.v1"} as never,
     attemptKey:attempt,businessDate:"2026-11-12",authorizationKind:"click" as const};
   const finished=await new SupervisorEffectGateway().finish(scope,claim,3,"verified","committed","2026-11-13");
   expect(finished.status).toBe("committed");
   expect(state.rpc).toHaveBeenCalledWith("supervisor_finish_gmail_effect_attempt",expect.anything());
   expect(state.rpc).not.toHaveBeenCalledWith("supervisor_finish_effect_attempt",expect.anything());
 });
 it("a missing provider receipt leaves an executing Gmail attempt uncertain, never resends",async()=>{
   const queries=mockFrom(row(),{attempt_key:attempt,business_date:"2026-11-12",state:"uncertain"});
   state.reconcile.mockResolvedValue(false);
   const pending=await new SupervisorEffectGateway().reconcileGmail(scope,id,3);
   expect(pending.status).toBe("executing");
   expect(queries).toHaveLength(1);
   expect(state.rpc).not.toHaveBeenCalled();
 });
 it("verified exact provider evidence completes through one scoped gateway RPC",async()=>{
   const queries=mockFrom(row(),{attempt_key:attempt,business_date:"2026-11-12",state:"uncertain"});
   state.reconcile.mockResolvedValue(true);
   state.rpc.mockResolvedValue({data:row("committed"),error:null});
   const finished=await new SupervisorEffectGateway().reconcileGmail(scope,id,3);
   expect(finished.status).toBe("committed");
   expect(queries.map(x=>x.table)).toEqual(["supervisor_proposals","supervisor_effect_attempts"]);
   expect(queries[0].filters).toEqual([
     ["business_id",scope.businessId],["owner_user_id",scope.ownerUserId],
     ["thread_id",scope.threadId],["id",id]]);
   expect(state.rpc).toHaveBeenCalledWith("supervisor_finish_gmail_effect_attempt",
     expect.objectContaining({p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
       p_thread_id:scope.threadId,p_proposal_id:id,p_attempt_key:attempt,p_state:"verified"}));
 });
 it("never reconciles a different café's proposal",async()=>{
   mockFrom({...row(),business_id:"77777777-7777-4777-8777-777777777777"},null);
   state.reconcile.mockResolvedValue(false);
   await expect(new SupervisorEffectGateway().reconcileGmail(scope,id,3))
     .rejects.toThrow("Gmail reconciliation scope unavailable");
   expect(state.reconcile).not.toHaveBeenCalled();
 });
});
