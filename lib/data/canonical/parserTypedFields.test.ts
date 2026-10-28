import {describe,it,expect} from "vitest";
import {extractToastTypedOrderFields as parse,extractToastTypedTimeEntryFields} from "./typedFields";
const guid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("Toast order typed details from retained provider shape",()=>{
 it("preserves duration, named discounts at check/item, tax, modifier price, void and refund",()=>{
  const x=parse({guid,openedDate:"2026-10-17T10:00:00Z",closedDate:"2026-10-17T10:15:30Z",
   checks:[{guid,appliedDiscounts:[{name:"Loyalty",nonTaxDiscountAmount:1.25}],
    selections:[{guid,tax:0.48,taxRate:0.08,voided:true,
     voidBusinessDate:20261017,voidReason:{guid},
     appliedDiscounts:[{name:"Happy Hour",discountAmount:2.5}],
     modifiers:[{item:{guid},price:0.75}],
     refundDetails:{refundAmount:1.10,refundBusinessDate:20261018}}],
    payments:[{guid,refund:{refundAmount:0.55,refundBusinessDate:20261018}}]}]});
  expect(x.durationSeconds).toBe(930);
  expect(x.checkDiscounts[0]).toMatchObject({name:"Loyalty",amountCents:125});
  expect(x.itemDiscounts[0]).toMatchObject({name:"Happy Hour",amountCents:250});
  expect(x.itemTaxes[0]).toMatchObject({taxAmountCents:48,taxRate:0.08});
  expect(x.modifierPrices[0]).toMatchObject({priceCents:75});
  expect(x.voidDetails[0]).toMatchObject({level:"selection",voidBusinessDate:20261017,reasonGuid:guid});
  expect(x.refundDetails).toEqual(expect.arrayContaining([expect.objectContaining({
   level:"payment",amountCents:55,businessDate:20261018})]));
 });
 it("keeps missing fields null instead of fake zero",()=>{
  const x=parse({checks:[{selections:[{}],payments:[{}]}]});
  expect(x.durationSeconds).toBeNull();expect(x.itemTaxes[0].taxAmountCents).toBeNull();
  expect(x.itemTaxes[0].taxRate).toBeNull();
 });
 it("malformed dates do not break source retention",()=>{
  expect(parse({openedDate:"bad",closedDate:"2026-10-17T10:15:30Z"}).durationSeconds).toBeNull();
 });
});
it("preserves Toast regular/overtime hours and exact hourly wage",()=>{
 expect(extractToastTypedTimeEntryFields({regularHours:7.5,overtimeHours:1.25,hourlyWage:18.75}))
  .toEqual({regularHours:7.5,overtimeHours:1.25,hourlyWageCents:1875});
 expect(extractToastTypedTimeEntryFields({})).toEqual({
  regularHours:null,overtimeHours:null,hourlyWageCents:null});
});

it("redacts contact and card-like values embedded in a discount name",()=>{
 const x=parse({checks:[{appliedDiscounts:[
  {name:"guest@example.com",discountAmount:1},
  {name:"4111111111111111",discountAmount:1},
  {name:"Staff Discount",discountAmount:1}]}]});
 expect(x.checkDiscounts.map(x=>x.name)).toEqual([null,null,"Staff Discount"]);
});
