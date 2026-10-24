import {describe,it,expect} from "vitest";
import {compareToastAnalytics,checkToastPaymentBalance,checkToastSelectionBalance} from "./toastReconciliation";
const base={
 importedNetSalesCents:100000,analyticsNetSalesCents:100000,
 importedOrderCount:100,analyticsOrderCount:100,
 importedDiscountCents:5000,analyticsDiscountCents:5000,
 importedRefundCents:1200,analyticsRefundCents:1200,
 importedVoidOrderCount:2,analyticsVoidOrderCount:2,
 toleranceCents:5
};
describe("Toast analytics cent-level proof (22, 23, V9)",()=>{
 it("matches ERA within four cents",()=>{
  expect(compareToastAnalytics({...base,analyticsNetSalesCents:100004}))
   .toMatchObject({matched:true,deltaNetCents:4,deltaOrders:0});
 });
 it("preserves a $12.30 mismatch as a signed integer-cent delta",()=>{
  expect(compareToastAnalytics({...base,analyticsNetSalesCents:101230}))
   .toMatchObject({matched:false,deltaNetCents:1230,deltaOrders:0});
 });
 it("void order count must match exactly regardless of net-sale tolerance",()=>{
  expect(compareToastAnalytics({...base,analyticsVoidOrderCount:3}))
   .toMatchObject({matched:false,deltaVoidOrders:1});
 });
 it("a mismatch later disappears when the independent source agrees",()=>{
  expect(compareToastAnalytics({...base,analyticsNetSalesCents:100100}).matched).toBe(false);
  expect(compareToastAnalytics(base).matched).toBe(true);
 });
 it("rejects fractional internal cents instead of guessing rounding",()=>{
  expect(()=>compareToastAnalytics({...base,analyticsNetSalesCents:0.5})).toThrow();
 });
});
describe("Toast per-check independent payment proof (25)",()=>{
 it("compares the closed check including tax and gratuity at one cent",()=>{
  expect(checkToastPaymentBalance(1000,80,100,[500,679])).toBe("matched");
  expect(checkToastPaymentBalance(1000,80,100,[500,660])).toBe("mismatch");
 });
 it("missing payment amounts remain unknown, not zero",()=>{
  expect(checkToastPaymentBalance(1000,80,0,[null,1080])).toBe("unknown");
  expect(checkToastPaymentBalance(null,80,0,[1080])).toBe("unknown");
 });
});

describe("closed check selection plus service-charge balance (V6)",()=>{
 it("includes service charges, discounts and one-cent tolerance",()=>{
  expect(checkToastSelectionBalance(1150,[1000,200],[50],[100])).toBe("matched");
  expect(checkToastSelectionBalance(1250,[1000,200],[50],[100])).toBe("mismatch");
 });
 it("does not certify absent selection, discount or service amounts",()=>{
  expect(checkToastSelectionBalance(1150,[null,200],[50],[100])).toBe("unknown");
  expect(checkToastSelectionBalance(1150,[1000,200],[null],[100])).toBe("unknown");
  expect(checkToastSelectionBalance(1150,[1000,200],[50],[null])).toBe("unknown");
 });
});
