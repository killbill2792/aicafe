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
  expect(calc({...base,cardEntryMode:"MANUAL"},plan).status).toBe("missing");
 });
 it("cash and gift card never have a processing fee",()=>{
  for(const type of ["CASH","GIFT_CARD"])
   expect(calc({...base,type},plan)).toEqual({amountCents:0,status:"actual",basis:"cash_or_gift"});
 });
 it("applies a single owner-confirmed general card rule to a known card and entry mode",()=>{
  expect(calc(base,[{cardType:"*",cardEntryMode:"*",percentageBps:290,fixedFeeCents:10}]))
   .toEqual({amountCents:39,status:"estimated",basis:"owner_plan"});
 });
 it("does not bill non-card methods or invent a missing card entry mode",()=>{
  expect(calc({...base,type:"HOUSE_ACCOUNT"},plan).status).toBe("missing");
  expect(calc({...base,cardEntryMode:null},[{cardType:"*",cardEntryMode:"*",
   percentageBps:290,fixedFeeCents:10}]).amountCents).toBeNull();
 });
 it("ambiguous equally specific owner fee rules are missing rather than double applied",()=>{
  expect(calc(base,[...plan,...plan]).status).toBe("missing");
 });
 it("unknown fee stays unknown, never an assumed zero",()=>{
  expect(calc(base,[]).amountCents).toBeNull();
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
