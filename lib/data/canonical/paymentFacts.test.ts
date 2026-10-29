import {describe,it,expect} from "vitest";
import {determineToastPaymentFee as calc} from "@/lib/calc/toastPaymentFee";
import {parseToastBusinessOrder} from "@/lib/pos/toast/dayParser";
const base={amountCents:1000,type:"CREDIT",cardType:"VISA",cardEntryMode:"SWIPED",originalProcessingFeeCents:null};
const plan=[{cardType:"VISA",cardEntryMode:"SWIPED",percentageBps:290,fixedFeeCents:10}];
describe("Toast payment fee source precedence",()=>{
 it("keeps originalProcessingFee $0.33 as real 33 cents",()=>{
  expect(calc({...base,originalProcessingFeeCents:33},plan))
   .toEqual({amountCents:33,status:"actual",basis:"toast"});
 });
 it("uses the matching card type and entry mode only when rate is owner-confirmed",()=>{
  expect(calc(base,plan)).toEqual({amountCents:39,status:"estimated",basis:"owner_plan"});
  // No owner rule for this entry mode: that one payment is estimated at the default card rate.
  expect(calc({...base,cardEntryMode:"MANUAL"},plan)).toMatchObject({status:"estimated",basis:"default_rate"});
 });
 it("cash and gift card never have a processing fee",()=>{
  for(const type of ["CASH","GIFT_CARD"])
   expect(calc({...base,type},plan)).toEqual({amountCents:0,status:"actual",basis:"cash_or_gift"});
 });
 it("applies a single owner-confirmed general card rule to a known card and entry mode",()=>{
  expect(calc(base,[{cardType:"*",cardEntryMode:"*",percentageBps:290,fixedFeeCents:10}]))
   .toEqual({amountCents:39,status:"estimated",basis:"owner_plan"});
 });
 it("does not bill non-card methods; an unknown tender stays missing",()=>{
  expect(calc({...base,type:"HOUSE_ACCOUNT"},plan)).toEqual({amountCents:0,status:"actual",basis:"cash_or_gift"});
  expect(calc({...base,type:"UNDETERMINED"},plan).amountCents).toBeNull();
  // A general owner rule still applies when Toast omits the entry mode.
  expect(calc({...base,cardEntryMode:null},[{cardType:"*",cardEntryMode:"*",
   percentageBps:290,fixedFeeCents:10}]).status).toBe("estimated");
 });
 it("ambiguous owner fee rules are never double applied: the default rate is used",()=>{
  expect(calc(base,[...plan,...plan])).toMatchObject({status:"estimated",basis:"default_rate"});
 });
 it("a card payment without a Toast fee is an estimate, never an assumed zero",()=>{
  // 2.9% of the payment, labelled estimated.
  const r=calc(base,[]);
  expect(r.status).toBe("estimated");
  expect(r.amountCents).toBeGreaterThan(0);
 });
});
describe("Toast parser typed payment preservation",()=>{
 it("keeps type, card type, entry mode and original fee without changing sales math",()=>{
  const p=parseToastBusinessOrder({guid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    businessDate:20261020,checks:[{amount:10,taxAmount:0,paymentStatus:"CLOSED",
     payments:[{guid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      amount:10,type:"CREDIT",cardType:"VISA",cardEntryMode:"SWIPED",originalProcessingFee:0.33}],
     selections:[]}]},
     "cccccccc-cccc-4ccc-8ccc-cccccccccccc","2026-10-20","America/Los_Angeles",4);
  expect(p.paymentFacts).toEqual([expect.objectContaining({
   amountCents:1000,originalProcessingFeeCents:33,type:"CREDIT",cardType:"VISA",cardEntryMode:"SWIPED"})]);
  expect(p.normalized?.netSalesCents).toBe(1000);
 });
});
