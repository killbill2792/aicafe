import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {readSupplierPurchaseOrders,readSupplierOrderCommunications,supplierCommunicationOwnerQuestion} from "./supplierPurchasing.server";

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

describe("Task14D canonical PO line delivery evidence",()=>{
 it("exposes ordered quantity rather than needed quantity and never infers physical receipt from Gmail",async()=>{
  const rows:Record<string,unknown[]>={
   purchase_orders:[{id:"po",status:"approved_for_ordering",revision:1,supplier_name_snapshot:"Supplier",
    currency_code:"CAD",subtotal_cents:20000,needed_by:"2026-11-19",approved_at:"2026-11-18T12:00:00Z"}],
   purchase_order_lines:[{id:"line",purchase_order_id:"po",ingredient_id:"milk",
    base_unit:"ml",item_name_snapshot:"Milk",packs:10,pack_unit:"liter",pack_quantity:10,
    unit_price_cents:2000,subtotal_cents:20000,quoted_on:"2026-11-18",delivery_on:"2026-11-20",ordinal:1}],
   purchase_order_dispatches:[{purchase_order_id:"po",state:"provider_accepted",provider_receipt_id:"sent"}]
  };
  const eq=vi.fn();const filters=vi.fn();
  const db={from:vi.fn((table:string)=>{
   const q={select(){return q},eq(field:string,value:string){eq(table,field,value);return q},
    in(field:string,values:string[]){filters(table,field,values);return q},
    order(){return q},limit(){return q},
    then(ok:(value:unknown)=>unknown,fail?:(reason:unknown)=>unknown){
     return Promise.resolve({data:rows[table]??[],error:null}).then(ok,fail);
    }};
   return q;
  })} as unknown as SupabaseClient;
  const result=await readSupplierPurchaseOrders(db,"cafe","owner");
  expect(eq).toHaveBeenCalledWith("purchase_orders","business_id","cafe");
  expect(eq).toHaveBeenCalledWith("purchase_orders","owner_user_id","owner");
  expect(eq).toHaveBeenCalledWith("purchase_order_lines","business_id","cafe");
  expect(filters).toHaveBeenCalledWith("purchase_order_lines","purchase_order_id",["po"]);
  expect(result.orders[0]).toMatchObject({sentToSupplier:true,receivedIntoInventory:false,
   receivingEvidence:"not_yet_verified",lines:[{orderLineId:"line",ingredientId:"milk",
    orderedBaseQuantity:100000,baseUnit:"ml",unitPriceCents:2000,expectedDeliveryOn:"2026-11-20"}]});
 });
});
