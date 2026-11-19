import {describe,it,expect} from "vitest";
import {buildVendorOrderEmail,formatVendorMoney} from "./vendorDispatch";

const order={
 id:"11111111-1111-4111-8111-111111111111",supplierName:"Sample Dairy",
 currency:"USD",subtotalCents:8000,neededBy:"2026-11-21",
 lines:[{itemName:"Milk",packs:4,packQuantity:1,packUnit:"case",lineSubtotalCents:8000}]
};
describe("Task14C vendor email",()=>{
 it("copies only the immutable PO ID, units, currency, and subtotal without inventing totals",()=>{
  const result=buildVendorOrderEmail(order);
  expect(result.subject).toContain(order.id);
  expect(result.body).toContain("Sample Dairy");
  expect(result.body).toContain("4 pack(s) of 1 case");
  expect(result.body).toContain("USD");
  expect(result.body).toContain("Shipping and tax have not been confirmed");
  expect(result.body).toContain("Requested delivery date: 2026-11-21");
  expect(result.body).toContain("confirm availability");
 });
 it("asks for delivery when no canonical date exists",()=>{
  const result=buildVendorOrderEmail({...order,neededBy:null});
  expect(result.body).toContain("Delivery date: please confirm");
 });
 it("fails closed on altered item subtotal",()=>{
  expect(()=>buildVendorOrderEmail({...order,subtotalCents:7999}))
    .toThrow("vendor_order_subtotal_mismatch");
 });
 it("fails closed on negative packs and empty lines",()=>{
  expect(()=>buildVendorOrderEmail({...order,lines:[]})).toThrow();
  expect(()=>buildVendorOrderEmail({...order,lines:[{...order.lines[0],packs:-1}]})).toThrow();
 });
 it("sanitizes multiline untrusted supplier names and items",()=>{
  const result=buildVendorOrderEmail({...order,supplierName:"Dairy\nBcc: attacker@example.com",
   lines:[{...order.lines[0],itemName:"Milk\r\nSubject: forged"}]});
  expect(result.body).not.toContain("\nBcc:");
  expect(result.body).not.toContain("\nSubject: forged");
 });
 it("formats the real ISO currency and rejects missing currencies",()=>{
  expect(formatVendorMoney(100,"JPY")).toMatch(/JPY|¥/);
  expect(()=>formatVendorMoney(120,"")).toThrow();
 });
});
