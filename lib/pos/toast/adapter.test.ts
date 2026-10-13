import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {normalizeToastOrder,toastMoneyCents} from "./adapter";
import {ToastApiError} from "./client";
const restaurant="00000000-0000-4000-8000-000000000001";
const base={guid:"00000000-0000-4000-8000-000000000002",
 closedDate:"2026-10-10T22:00:00.000+0000",checks:[{
  paymentStatus:"CLOSED",closedDate:"2026-10-10T22:00:00Z",
  amount:10,taxAmount:0.75,appliedDiscounts:[{nonTaxDiscountAmount:2}],
  selections:[{displayName:"Tea",quantity:1,price:10,voided:false,
    appliedDiscounts:[],modifiers:[],refundDetails:null}],
  payments:[{tipAmount:2,refundStatus:"NONE",refund:null}]}]};
describe("Toast read-only normalization",()=>{
 it("converts dollar doubles to exact cents and rejects unrepresentable money",()=>{
   expect(toastMoneyCents(11.05)).toBe(1105);
   expect(toastMoneyCents(0.29)).toBe(29);
   expect(()=>toastMoneyCents(0.001)).toThrow(ToastApiError);
 });
 it("does not double-subtract discounts or include tax/tips in net sales",()=>{
   expect(normalizeToastOrder(base,restaurant)).toMatchObject({
     grossSalesCents:1200,discountsCents:200,refundsCents:0,netSalesCents:1000,
     taxCents:75,tipCents:200,processingFeeStatus:"missing",processingFeeCents:0});
 });
 it("rejects open and missing-close-date orders",()=>{
   expect(normalizeToastOrder({...base,checks:[{...base.checks[0],paymentStatus:"OPEN"}]},restaurant)).toBeNull();
   expect(()=>normalizeToastOrder({...base,closedDate:null},restaurant)).toThrow(ToastApiError);
 });
 it("handles an explicit selection refund once",()=>{
   const check={...base.checks[0],
    selections:[{...base.checks[0].selections[0],refundDetails:{refundAmount:3}}],
    payments:[{tipAmount:2,refundStatus:"PARTIAL",refund:{refundAmount:3,tipRefundAmount:0.5}}]};
   expect(normalizeToastOrder({...base,checks:[check]},restaurant)).toMatchObject({
     grossSalesCents:1200,discountsCents:200,refundsCents:300,netSalesCents:700,tipCents:150});
 });
});
