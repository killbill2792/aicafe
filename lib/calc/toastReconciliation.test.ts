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

describe("Toast documented Check.amount semantics: auto-gratuity and gift cards",()=>{
 it("does not double-count $8 mandatory gratuity as both a charge and payment",()=>{
  // check.amount=$50 sale +$5 retained fee; auto-grat is outside amount.
  expect(checkToastSelectionBalance(5500,[5000],[500],[])).toBe("matched");
  // payment.amount excludes gratuity and guest tips.
  expect(checkToastPaymentBalance(5500,440,800,[6740])).toBe("matched");
  expect(checkToastPaymentBalance(5500,440,1600,[6740])).toBe("mismatch");
 });
 it("includes deferred gift-card purchases in CHECK amount, not in NET sales",()=>{
  // A $30 deferred gift-card sale is on the guest's check alongside $20 coffee.
  // It must not disappear from the check reconciliation just because the net-
  // sales importer excludes deferred revenue.
  expect(checkToastSelectionBalance(5000,[2000,3000],[],[])).toBe("matched");
  expect(checkToastSelectionBalance(5000,[2000],[],[])).toBe("mismatch");
  // Payment amount includes the whole guest check even when net sales are $20.
  expect(checkToastPaymentBalance(5000,0,0,[3000,2000])).toBe("matched");
 });
 it("selection.price already includes an item discount; subtract only check-level discounts",()=>{
  // $15 item, $2 item discount => selection.price=$13.
  // An additional $1 check-level discount yields Check.amount=$12.
  expect(checkToastSelectionBalance(1200,[1300],[],[100])).toBe("matched");
  expect(checkToastSelectionBalance(1200,[1300],[],[100,200])).toBe("mismatch");
 });
});
