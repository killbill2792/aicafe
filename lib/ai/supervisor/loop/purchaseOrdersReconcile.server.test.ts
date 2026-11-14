import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
vi.mock("./effectGateway.server",()=>({SupervisorEffectGateway:class {}}));
vi.mock("./purchaseOrders.server",()=>({
 supplierPurchaseOrderCapabilityId:"maya.supplier_purchase_order.v1"
}));
import {reconcilePendingSupplierPurchaseOrders} from "./purchaseOrdersReconcile.server";

const row=(id:string)=>({
 id,business_id:"11111111-1111-4111-8111-111111111111",
 owner_user_id:"22222222-2222-4222-8222-222222222222",
 thread_id:"33333333-3333-4333-8333-333333333333",revision:3,locale:"en",
 status:"executing",updated_at:"2026-11-14T05:00:00Z"
});
function fakeStore(rows:ReturnType<typeof row>[],queryError=false){
 const updates:Array<Record<string,unknown>>=[];
 const selected:string[]=[];
 const reads={
  select:(_columns:string)=>reads,
  eq:(name:string,_value:unknown)=>{selected.push(name);return reads;},
  lte:(name:string,_value:unknown)=>{selected.push(name);return reads;},
  order:(_name:string,_options:unknown)=>reads,
  limit:async(n:number)=>{
   expect(n).toBe(25);
   return {data:queryError?null:rows,error:queryError?{message:"offline"}:null};
  }
 };
 const write={
  update:(value:Record<string,unknown>)=>{updates.push(value);return write;},
  eq:(_name:string,_value:unknown)=>write,
  then:(resolve:(value:{error:null})=>unknown,reject:(err:unknown)=>unknown)=>
    Promise.resolve({error:null}).then(resolve,reject)
 };
 return {db:{from:(_table:string)=>({
  select:reads.select,update:write.update,
 })} as unknown as SupabaseClient,selected,updates};
}
describe("Task14B existing-worker proof-based PO recovery",()=>{
 it("recovers a single scoped verified PO without repeating the purchase effect",async()=>{
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
  expect(store.selected).toEqual(expect.arrayContaining(["capability_id","status","updated_at"]));
  expect(store.updates).toHaveLength(1);
  expect(store.updates[0].monitor_checked_at).toBe("2026-11-14T06:00:00.000Z");
 });
 it("keeps uncertainty visible and rotates failed attempts rather than resending",async()=>{
  const store=fakeStore([row("44444444-4444-4444-8444-444444444444"),
   row("55555555-5555-4555-8555-555555555555")]);
  const gateway={reconcileSupplierPurchaseOrder:vi.fn()
   .mockRejectedValueOnce(new Error("offline"))
   .mockResolvedValueOnce({status:"executing"})};
  expect(await reconcilePendingSupplierPurchaseOrders(store.db,gateway as never,
    new Date("2026-11-14T06:00:00Z"))).toEqual({
     checked:2,verified:0,uncertain:1,failed:1
    });
  expect(store.updates).toHaveLength(2);
  expect(gateway.reconcileSupplierPurchaseOrder).toHaveBeenCalledTimes(2);
 });
 it("fails visibly rather than inventing a healthy worker read",async()=>{
  const store=fakeStore([],true);
  await expect(reconcilePendingSupplierPurchaseOrders(store.db,
    {reconcileSupplierPurchaseOrder:vi.fn()} as never))
    .rejects.toThrow("supplier_po_reconciliation_queue_unavailable");
 });
});
