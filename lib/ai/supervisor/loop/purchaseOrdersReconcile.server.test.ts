import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
vi.mock("./effectGateway.server",()=>({SupervisorEffectGateway:class {}}));
import {reconcilePendingSupplierPurchaseOrders} from "./purchaseOrdersReconcile.server";

const row=(id:string)=>({
 id,business_id:"11111111-1111-4111-8111-111111111111",
 owner_user_id:"22222222-2222-4222-8222-222222222222",
 thread_id:"33333333-3333-4333-8333-333333333333",revision:3,locale:"en",
});
function fakeStore(rows:ReturnType<typeof row>[],queryError=false){
 const rpc=vi.fn(async(name:string,args:unknown)=>{
  if(name!=="supervisor_claim_supplier_po_recovery")throw new Error("unexpected_rpc");
  return {data:queryError?null:rows,error:queryError?{message:"offline"}:null};
 });
 const forbiddenProposalWrite=vi.fn(()=>{throw new Error("immutable_proposal_write_forbidden")});
 return {db:{rpc,from:forbiddenProposalWrite} as unknown as SupabaseClient,
  rpc,forbiddenProposalWrite};
}
describe("Task14B existing-worker proof-based PO recovery",()=>{
 it("recovers a scoped durable receipt without mutating proposal or resending effect",async()=>{
  const id="44444444-4444-4444-8444-444444444444";
  const store=fakeStore([row(id)]);
  const gateway={reconcileSupplierPurchaseOrder:vi.fn(async()=>({status:"committed" as const}))};
  const result=await reconcilePendingSupplierPurchaseOrders(
   store.db,gateway as never,new Date("2026-11-14T06:00:00Z"));
  expect(result).toEqual({checked:1,verified:1,uncertain:0,failed:0});
  expect(gateway.reconcileSupplierPurchaseOrder).toHaveBeenCalledWith({
   businessId:row(id).business_id,ownerUserId:row(id).owner_user_id,
   threadId:row(id).thread_id,locale:"en"
  },id,3);
  expect(store.rpc).toHaveBeenCalledWith("supervisor_claim_supplier_po_recovery",{
   p_limit:25,p_cutoff:"2026-11-14T05:55:00.000Z"
  });
  expect(store.forbiddenProposalWrite).not.toHaveBeenCalled();
 });
 it("rotates unknown outcomes in the effect ledger claim without retrying a PO write",async()=>{
  const store=fakeStore([row("44444444-4444-4444-8444-444444444444"),
   row("55555555-5555-4555-8555-555555555555")]);
  const gateway={reconcileSupplierPurchaseOrder:vi.fn()
   .mockRejectedValueOnce(new Error("offline"))
   .mockResolvedValueOnce({status:"executing"})};
  expect(await reconcilePendingSupplierPurchaseOrders(store.db,gateway as never,
   new Date("2026-11-14T06:00:00Z"))).toEqual({
    checked:2,verified:0,uncertain:1,failed:1
   });
  expect(store.rpc).toHaveBeenCalledTimes(1);
  expect(store.forbiddenProposalWrite).not.toHaveBeenCalled();
  expect(gateway.reconcileSupplierPurchaseOrder).toHaveBeenCalledTimes(2);
 });
 it("fails visibly rather than inventing a healthy worker read",async()=>{
  const store=fakeStore([],true);
  await expect(reconcilePendingSupplierPurchaseOrders(store.db,
   {reconcileSupplierPurchaseOrder:vi.fn()} as never))
   .rejects.toThrow("supplier_po_reconciliation_queue_unavailable");
 });
});
