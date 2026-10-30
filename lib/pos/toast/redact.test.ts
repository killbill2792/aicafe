import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {redactToastRaw} from "./redact";
import {parseToastDayPage} from "./dayParser";

const restaurant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const day="2026-10-16";
const guid=(n:number)=>`${String(n).padStart(8,"0")}-aaaa-4aaa-8aaa-${String(n).padStart(12,"0")}`;
// A realistic Toast order with the personal fields Toast sends next to business data.
const order={
 guid:guid(1),businessDate:20261016,openedDate:"2026-10-16T15:30:00.000-0700",
 closedDate:"2026-10-16T15:45:00.000-0700",modifiedDate:"2026-10-16T22:50:00.000+0000",
 server:{guid:guid(2),entityType:"RestaurantUser"},diningOption:{guid:guid(3),name:"Dine In"},
 customer:{guid:guid(4),firstName:"Ana",lastName:"Lopez",email:"ana@example.com",phone:"555-123-4567"},
 checks:[{
  guid:guid(5),displayNumber:"12",tabName:"Ana",paymentStatus:"CLOSED",amount:12.5,taxAmount:1.1,
  closedDate:"2026-10-16T15:45:00.000-0700",
  customer:{guid:guid(6),firstName:"Ana",email:"ana@example.com"},
  appliedDiscounts:[{guid:guid(7),name:"Happy hour",discountAmount:1,discount:{guid:guid(8)}}],
  appliedServiceCharges:[{guid:guid(9),name:"Service",chargeAmount:0.5,gratuity:false}],
  selections:[{guid:guid(10),displayName:"Oat latte",item:{guid:guid(11)},quantity:2,price:11,
   preDiscountPrice:12,receiptLinePrice:5.5,tax:1.1,salesCategory:{guid:guid(12),name:"Coffee"},
   modifiers:[{guid:guid(13),displayName:"Oat milk",item:{guid:guid(14)},quantity:1,price:0.75,
    optionGroup:{guid:guid(15)}}],
   appliedDiscounts:[{guid:guid(16),name:"Promo",discountAmount:0.5}]},
   {guid:guid(17),displayName:"Muffin",item:{guid:guid(18)},quantity:1,price:3,voided:true,
    voidBusinessDate:20261016,voidReason:{guid:guid(19)}}],
  payments:[{guid:guid(20),paymentStatus:"CAPTURED",type:"CREDIT",cardType:"VISA",
   cardEntryMode:"EMV_CHIP_SIGN",last4Digits:"4242",cardholderName:"ANA LOPEZ",amount:12.5,
   tipAmount:2,originalProcessingFee:0.41,paidBusinessDate:20261016}]
 }]
};

describe("Toast day pages are redacted once in the app",()=>{
 it("parses a redacted page exactly like the raw page",()=>{
  const raw=[order,{...order,guid:guid(30),checks:[{...order.checks[0],guid:guid(31)}]}];
  const parse=(page:unknown)=>parseToastDayPage(page,restaurant,day,"America/Los_Angeles",4);
  expect(parse(raw).orders).toHaveLength(2);
  expect(parse(raw).orders[0].normalized?.netSalesCents).toBeGreaterThan(0);
  expect(parse(redactToastRaw(raw,0,"",undefined,"orders"))).toEqual(parse(raw));
 });
 it("drops customer details and card data but keeps the payment fee fields",()=>{
  const safe=JSON.stringify(redactToastRaw([{...order,name:"Ana's order",displayName:"Ana L",nickname:"Ani"}],0,"",undefined,"orders"));
  for(const leaked of ["Ana's order","Ana L","Ani","Lopez","ana@example.com","555-123-4567","4242","ANA LOPEZ",'"tabName"'])
   expect(safe).not.toContain(leaked);
  expect(safe).toContain('"originalProcessingFee":0.41');
  expect(safe).toContain('"cardType":"VISA"');
 });
 it("is stable when a page is redacted twice (staged pages are read back)",()=>{
  const once=redactToastRaw([order],0,"",undefined,"orders");
  expect(redactToastRaw(once,0,"",undefined,"orders")).toEqual(once);
 });
});
