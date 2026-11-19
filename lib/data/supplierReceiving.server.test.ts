import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {readSupplierReconciliation} from "./supplierReceiving.server";
const scope={business_id:"cafe",purchase_order_id:"po",supplier_id:"vendor"};
const rows:Record<string,Record<string,unknown>[]>={
 purchase_orders:[{id:"po",business_id:"cafe",owner_user_id:"owner",supplier_id:"vendor",
  supplier_name_snapshot:"Supplier",currency_code:"CAD",status:"approved_for_ordering",
  revision:1,subtotal_cents:20000,needed_by:"2026-11-19",approved_at:"2026-11-18T12:00:00Z"}],
 purchase_order_lines:[{...scope,id:"order-line",ingredient_id:"milk",base_unit:"ml",
  item_name_snapshot:"Milk",packs:10,pack_unit:"l",pack_quantity:10,
  unit_price_cents:2000,subtotal_cents:20000,quoted_on:"2026-11-18",delivery_on:"2026-11-19"}],
 purchase_order_dispatches:[],
 purchase_receipts:[{...scope,owner_user_id:"owner",id:"receipt",receiving_reference:"delivery-1",revision:1,
  verification_kind:"owner_confirmed",verification_ref:"owner-message",verified_at:"2026-11-19T12:00:00Z"}],
 purchase_receipt_lines:[{...scope,receipt_id:"receipt",source_line_key:"1",order_line_id:"order-line",
  ingredient_id:"milk",received_base4:600000000,accepted_base4:600000000,damaged_base4:0}],
 supplier_invoices:[{...scope,owner_user_id:"owner",id:"invoice",invoice_reference:"invoice-1",revision:1,
  currency_code:"CAD",subtotal_cents:20000,tax_cents:0,freight_cents:0,discount_cents:0,total_cents:20000}],
 supplier_invoice_lines:[{...scope,invoice_id:"invoice",source_line_key:"1",order_line_id:"order-line",
  ingredient_id:"milk",quantity_base4:1000000000,subtotal_cents:20000}],
};
function database(data=rows){
 const from=vi.fn((table:string)=>{
  let result=[...(data[table]??[])];
  const q={select(){return q},eq(field:string,value:unknown){result=result.filter(r=>r[field]===value);return q},
   in(field:string,values:unknown[]){result=result.filter(r=>values.includes(r[field]));return q},
   order(){return q},limit(n:number){result=result.slice(0,n);return q},
   then(ok:(value:unknown)=>unknown,fail?:(reason:unknown)=>unknown){
    return Promise.resolve({data:result,error:null}).then(ok,fail);
   }};
  return q;
 });
 return {db:{from} as unknown as SupabaseClient,from};
}
describe("authenticated PO reconciliation read projection",()=>{
 it("compares real ordered and recorded source quantities without claiming recorded stock or expense",async()=>{
  const {db}=database();
  const r=await readSupplierReconciliation(db,"cafe","owner","po");
  expect(r.reconciliation).toMatchObject({purchaseOrderId:"po",verifiedInvoiceTotalCents:20000,
   closureVerified:false,canonicalStockEffectVerified:false,canonicalExpenseEffectVerified:false,
   payableCents:null,paidCents:null,matchingEvidence:false,lines:[{orderedQuantity:100000,
    verifiedReceivedQuantity:60000,acceptedQuantity:60000,invoicedQuantity:100000,
    unverifiedOutstandingQuantity:40000,baseUnit:"ml"}]});
  expect(r.reconciliation?.issues).toContain("invoice_not_received");
 });
 it("refuses wrong cafe/owner/PO before querying document sources",async()=>{
  for(const [business,owner,po] of [["other","owner","po"],["cafe","other","po"],["cafe","owner","other"]]){
   const {db,from}=database();
   expect(await readSupplierReconciliation(db,business,owner,po)).toEqual({
    missing:["purchase_order_unavailable"],reconciliation:null});
   expect(from).not.toHaveBeenCalledWith("purchase_receipts");
   expect(from).not.toHaveBeenCalledWith("supplier_invoices");
  }
 });
 it("invoice alone cannot establish any received quantity",async()=>{
  const {db}=database({...rows,purchase_receipts:[],purchase_receipt_lines:[]});
  const r=await readSupplierReconciliation(db,"cafe","owner","po");
  expect(r.reconciliation).toMatchObject({physicalEvidenceStatus:"not_yet_verified",
   lines:[{verifiedReceivedQuantity:0,acceptedQuantity:0,unverifiedOutstandingQuantity:100000}],
   closureVerified:false});
 });
 it("fails closed instead of using a truncated document history",async()=>{
  const {db}=database({...rows,purchase_receipts:Array.from({length:101},(_,i)=>({
   ...rows.purchase_receipts[0],id:"receipt-"+i,receiving_reference:"r-"+i
  }))});
  expect(await readSupplierReconciliation(db,"cafe","owner","po")).toEqual({
   missing:["receiving_or_invoice_history_truncated"],reconciliation:null});
 });
});
