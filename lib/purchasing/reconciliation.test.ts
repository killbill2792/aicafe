import {describe,expect,it} from "vitest";
import {reconcilePurchaseOrder,type OrderSnapshot,type ReceivingDocument,type InvoiceDocument} from "./reconciliation";
const order:OrderSnapshot={businessId:"cafe-a",id:"po-a",supplierId:"vendor-a",currency:"CAD",
 lines:[{id:"po-line-a",ingredientId:"milk",orderedBase4:1000000,subtotalCents:20000}]};
const identity={businessId:order.businessId,purchaseOrderId:order.id,supplierId:order.supplierId};
const receiving=(id:string,quantity:number,revision=1):ReceivingDocument=>({...identity,id,revision,
 verifiedPhysicalReceipt:true,lines:[{id:"line",orderLineId:"po-line-a",ingredientId:"milk",
 receivedBase4:quantity,acceptedBase4:quantity,damagedBase4:0}]});
const invoice=(id:string,quantity:number,total:number,revision=1):InvoiceDocument=>({...identity,id,revision,
 currency:order.currency,subtotalCents:total,taxCents:0,freightCents:0,discountCents:0,totalCents:total,
 lines:[{id:"line",orderLineId:"po-line-a",ingredientId:"milk",quantityBase4:quantity,subtotalCents:total}]});
describe("Task14D deterministic evidence reconciliation (not an effect or closure receipt)",()=>{
 it("matches full delivery and invoice without claiming stock, payable or paid",()=>{
  const r=reconcilePurchaseOrder(order,[receiving("delivery",1000000)],[invoice("i",1000000,20000)]);
  expect(r).toMatchObject({matchingEvidence:true,closureVerified:false,payableCents:null,paidCents:null,
    verifiedInvoiceTotalCents:20000,issues:[],lines:[{verifiedReceivedBase4:1000000,
     acceptedBase4:1000000,invoicedBase4:1000000,outstandingBase4:0}]});
 });
 it("keeps partial delivery and full invoice discrepancy open",()=>{
  const r=reconcilePurchaseOrder(order,[receiving("delivery",600000)],[invoice("i",1000000,20000)]);
  expect(r.lines[0]).toMatchObject({acceptedBase4:600000,outstandingBase4:400000});
  expect(r.issues).toEqual(expect.arrayContaining(["short_delivery","invoice_not_received","invoice_quantity_difference"]));
  expect(r.matchingEvidence).toBe(false);
 });
 it("adds distinct installments but ignores duplicate receipt and invoice identities",()=>{
  const a=receiving("delivery-1",600000),b=receiving("delivery-2",400000);
  const i=invoice("inv",1000000,20000);
  const r=reconcilePurchaseOrder(order,[a,b,a,b],[i,i]);
  expect(r.matchingEvidence).toBe(true);
  expect(r.lines[0].verifiedReceivedBase4).toBe(1000000);
  expect(r.verifiedInvoiceTotalCents).toBe(20000);
 });
 it("selects latest authorized revision instead of summing corrections",()=>{
  const r=reconcilePurchaseOrder(order,
   [receiving("r",1000000,1),receiving("r",600000,2),receiving("r",1000000,1)],
   [invoice("i",1000000,22000,1),invoice("i",600000,12000,2)]);
  expect(r.verifiedInvoiceTotalCents).toBe(12000);
  expect(r.lines[0]).toMatchObject({acceptedBase4:600000,invoicedBase4:600000,outstandingBase4:400000});
  expect(r.issues).toEqual(["short_delivery"]);
 });
 it("fails closed on conflicting contents of the same revision",()=>{
  const r=reconcilePurchaseOrder(order,[receiving("r",600000),receiving("r",1000000)],
   [invoice("i",1000000,20000)]);
  expect(r.issues).toContain("ambiguous_revision");
  expect(r.lines[0].verifiedReceivedBase4).toBe(0);
  expect(r.verifiedInvoiceTotalCents).toBeNull();
 });
 it("invoice or unverified supplier documentation alone does not count as physical receipt",()=>{
  const r=reconcilePurchaseOrder(order,[{...receiving("note",1000000),verifiedPhysicalReceipt:false}],
   [invoice("i",1000000,20000)]);
  expect(r.lines[0].acceptedBase4).toBe(0);
  expect(r.issues).toEqual(expect.arrayContaining(["physical_receipt_unverified","invoice_not_received"]));
 });
 it("does not accept damaged goods as usable stock",()=>{
  const d=receiving("r",1000000);
  const r=reconcilePurchaseOrder(order,[{...d,lines:[{...d.lines[0],acceptedBase4:800000,damagedBase4:200000}]}],
   [invoice("i",1000000,20000)]);
  expect(r.lines[0]).toMatchObject({verifiedReceivedBase4:1000000,acceptedBase4:800000,damagedBase4:200000,outstandingBase4:200000});
  expect(r.issues).toContain("damaged_goods");
 });
 it("rejects incorrect products and detects excess deliveries",()=>{
  const d=receiving("r",1000000);
  const wrong={...d,lines:[{...d.lines[0],ingredientId:"not-milk"}]};
  expect(reconcilePurchaseOrder(order,[wrong],[]).lines[0].acceptedBase4).toBe(0);
  expect(reconcilePurchaseOrder(order,[wrong],[]).issues).toContain("incorrect_product");
  expect(reconcilePurchaseOrder(order,[receiving("r",1200000)],[]).issues).toContain("excess_delivery");
 });
 it("detects overcharge, bad invoice arithmetic and unknown tax",()=>{
  const d=receiving("r",1000000),i=invoice("i",1000000,22000);
  expect(reconcilePurchaseOrder(order,[d],[i]).issues).toContain("invoice_price_difference");
  expect(reconcilePurchaseOrder(order,[d],[{...i,totalCents:100}]).issues).toContain("invoice_total_difference");
  expect(reconcilePurchaseOrder(order,[d],[{...i,taxCents:null}]).verifiedInvoiceTotalCents).toBeNull();
 });
 it("rejects foreign cafe, wrong supplier, ambiguous PO and currency mismatch",()=>{
  const d=receiving("r",1000000),i=invoice("i",1000000,20000);
  for(const invalid of [{...d,businessId:"cafe-b"},{...d,supplierId:"other"},
    {...d,supplierId:""},{...d,purchaseOrderId:"other"}]){
   const r=reconcilePurchaseOrder(order,[invalid],[i]);
   expect(r.issues).toContain("unresolved_identity");
   expect(r.lines[0].acceptedBase4).toBe(0);
  }
  expect(reconcilePurchaseOrder(order,[d],[{...i,currency:"EUR"}]).issues).toContain("invoice_currency_mismatch");
 });
 it("does not count repeated line IDs, negative quantities or incomplete money",()=>{
  const d=receiving("r",1000000);
  expect(reconcilePurchaseOrder(order,[{...d,lines:[d.lines[0],d.lines[0]]}],[]).issues).toContain("invalid_receipt");
  expect(reconcilePurchaseOrder(order,[receiving("r",-1)],[]).lines[0].acceptedBase4).toBe(0);
  expect(reconcilePurchaseOrder(order,[d],[]).verifiedInvoiceTotalCents).toBeNull();
 });
 it("prorates correctly without using floating point money",()=>{
  const p={...order,lines:[{...order.lines[0],orderedBase4:3,subtotalCents:100}]};
  const r=reconcilePurchaseOrder(p,[receiving("r",1)],[invoice("i",1,33)]);
  expect(r.issues).not.toContain("invoice_price_difference");
 });
});
