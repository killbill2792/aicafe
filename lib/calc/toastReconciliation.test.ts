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

describe("closed check selection amounts already net of all discounts",()=>{
 it("balances check-level percentage and fixed discounts without deducting twice",()=>{
  expect(checkToastSelectionBalance(900,[900],[])).toBe("matched");
  expect(checkToastSelectionBalance(800,[800],[])).toBe("matched");
  expect(checkToastSelectionBalance(900,[1000],[])).toBe("mismatch");
 });
 it("balances item-level discount and non-gratuity service charges",()=>{
  expect(checkToastSelectionBalance(1350,[1300],[50])).toBe("matched");
  expect(checkToastSelectionBalance(1350,[1300],[null])).toBe("unknown");
  expect(checkToastSelectionBalance(1350,[null],[50])).toBe("unknown");
 });
 it("excludes gratuity but includes deferred gift card selection amounts",()=>{
  expect(checkToastSelectionBalance(5000,[2000,3000],[])).toBe("matched");
  expect(checkToastSelectionBalance(5000,[2000],[])).toBe("mismatch");
  expect(checkToastPaymentBalance(5000,400,800,[6200])).toBe("matched");
 });
});
