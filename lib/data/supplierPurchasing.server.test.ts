import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {readSupplierOrderCommunications,supplierCommunicationOwnerQuestion} from "./supplierPurchasing.server";

describe("Task14C supplier owner follow-up truth",()=>{
 it.each(["supplier_accepted","supplier_declined"])(
  "a terminal %s owner report prevents proposing another send regardless of Gmail state",
  outcome=>{
   for(const state of ["not_prepared","prepared","send_uncertain","provider_accepted"])
    for(const contactVerified of [false,true])
     expect(supplierCommunicationOwnerQuestion({
      contactVerified,channel:"gmail",state,ownerReportedOutcome:outcome
     })).toBeNull();
  });
 it("nonterminal owner reports still request a concrete next step",()=>{
  expect(supplierCommunicationOwnerQuestion({
   contactVerified:true,channel:"phone",state:"not_prepared",
   ownerReportedOutcome:"supplier_acknowledged"
  })).toContain("Was the order placed");
  expect(supplierCommunicationOwnerQuestion({
   contactVerified:false,channel:null,state:"not_prepared",
   ownerReportedOutcome:null
  })).toContain("Which channel");
  expect(supplierCommunicationOwnerQuestion({
   contactVerified:true,channel:"gmail",state:"send_uncertain",
   ownerReportedOutcome:"supplier_contacted"
  })).toContain("will not resend");
 });
 function scopedReader(outcomes:string[],state:string|null=null){
  const data:Record<string,unknown[]>={
   purchase_orders:[{id:"po",supplier_id:"supplier"}],
   cafe_supplier_order_contacts:[{supplier_id:"supplier",channel:"gmail",
    email:"verified@example.invalid",verified_at:"2026-11-17T10:00:00Z",revoked_at:null}],
   purchase_order_dispatches:state?[{purchase_order_id:"po",state,provider_receipt_id:null}]:[],
   purchase_order_channel_reports:outcomes.map(outcome=>({
    purchase_order_id:"po",outcome,reported_at:"2026-11-17T10:00:00Z"
   }))
  };
  const mock={from:vi.fn((table:string)=>{
   const q={
    select(){return q},eq(){return q},in(){return q},order(){return q},limit(){return q},
    then(ok:(value:unknown)=>unknown,fail?:(reason:unknown)=>unknown){
     return Promise.resolve({data:data[table]??[],error:null}).then(ok,fail);
    }
   };
   return q;
  })};
  return mock as unknown as SupabaseClient;
 }
 it("the actual reader prefers accepted owner evidence over a later ambiguous note and an unsent Gmail state",async()=>{
  const statuses=await readSupplierOrderCommunications(
   scopedReader(["unknown","supplier_accepted","supplier_acknowledged"]),"cafe","owner",["po"]);
  expect(statuses).toMatchObject([{purchaseOrderId:"po",state:"not_prepared",
   channel:"gmail",contactVerified:true,ownerReportedOutcome:"supplier_accepted",
   providerVerified:false,ownerQuestion:null}]);
 });
 it("the actual reader gives a declined owner report precedence over an uncertain Gmail reservation",async()=>{
  const statuses=await readSupplierOrderCommunications(
   scopedReader(["supplier_contacted","supplier_declined"],"reserved"),"cafe","owner",["po"]);
  expect(statuses).toMatchObject([{purchaseOrderId:"po",state:"send_uncertain",
   ownerReportedOutcome:"supplier_declined",providerVerified:false,ownerQuestion:null}]);
 });
});
