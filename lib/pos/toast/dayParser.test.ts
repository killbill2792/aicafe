import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {parseToastDayPage,parseToastBusinessOrder,toastCents} from "./dayParser";
const restaurant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orderGuid="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const selectionGuid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const day="2026-10-16";
const check={guid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",paymentStatus:"PAID",
 amount:10,taxAmount:0.75,selections:[{guid:selectionGuid,quantity:1,price:10,
 displayName:"Tea"}],payments:[]};
const order={guid:orderGuid,businessDate:20261016,openedDate:"2026-10-17T01:30:00.000-0700",
 modifiedDate:"2026-10-17T08:35:00.000+0000",checks:[check]};
const parse=(o:unknown)=>parseToastBusinessOrder(o,restaurant,day,"America/Los_Angeles",4);
describe("Toast daily parser / trustworthy void facts",()=>{
 it("includes PAID/OPEN checks without close dates and trusts businessDate across midnight",()=>{
  const x=parse({...order,checks:[check,{...check,guid:null,paymentStatus:"OPEN",amount:5}]});
  expect(x.normalized?.netSalesCents).toBe(1500);
  expect(x.openChecks).toBe(2);
  expect(x.includedChecks).toBe(2);
 });
 it("isolates malformed orders without throwing out valid page mates",()=>{
  const page=parseToastDayPage([order,{...order,guid:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
   checks:[{...check,amount:"abc"}]}],restaurant,day,"America/Los_Angeles",4);
  expect(page.orders).toHaveLength(1);
  expect(page.unparsed).toHaveLength(1);
  expect(page.unparsed[0].error_path).toContain("checks.0.amount");
 });
 it("subtracts payment refunds once and not a second time from check net",()=>{
  const x=parse({...order,checks:[{...check,payments:[{paymentStatus:"CAPTURED",
   guid:"ffffffff-ffff-4fff-8fff-ffffffffffff",
   refund:{refundAmount:4.5,tipRefundAmount:0.5,refundBusinessDate:20261017},tipAmount:2}]}]});
  expect(x.normalized?.netSalesCents).toBe(550);
  expect(x.normalized?.tipCents).toBe(150);
  expect(x.refundFacts[0].refund_business_date).toBe("2026-10-17");
 });
 it("captures voids from selections, checks and orders without altering sales",()=>{
  const voided={...check,selections:[{...check.selections[0],voided:true,
   preDiscountPrice:6,voidBusinessDate:20261017}]};
  const x=parse({...order,checks:[voided]});
  expect(x.normalized?.netSalesCents).toBe(1000);
  expect(x.normalized?.lines[0].netSalesCents).toBe(0);
  expect(x.voids).toMatchObject([{amount_cents:600,level:"selection",void_business_date:"2026-10-17"}]);
  const y=parse({...order,checks:[{...check,voided:true}]});
  expect(y.normalized).toBeNull();
  expect(y.voids).toMatchObject([{amount_cents:1000,level:"check"}]);
  const z=parse({...order,voided:true});
  expect(z.normalized).toBeNull();
  expect(z.voids).toMatchObject([{amount_cents:1000,level:"order"}]);
 });
 it("deleted merged checks are not voids, and missing void amount cannot imply zero",()=>{
  const a=parse({...order,deleted:true,checks:[{...check,voided:true}]});
  expect(a.voids).toHaveLength(0);
  const b=parse({...order,checks:[{...check,selections:[{
   guid:selectionGuid,displayName:"Tea",quantity:1,voided:true}]}]});
  expect(b.voids[0]).toMatchObject({amount_basis:"amount_missing",amount_cents:null});
 });
 it("rounds half away from zero and records subcent warnings",()=>{
  expect(toastCents(1.005)).toBe(101);
  expect(toastCents(-1.005)).toBe(-101);
  const x=parse({...order,checks:[{...check,taxAmount:1.005}]});
  expect(x.warnings.subcent_rounding).toBe(1);
 });
 it("keeps nullable monetary fields parseable but warns rather than silently certifying zeros",()=>{
  const x=parse({...order,checks:[{...check,amount:null,taxAmount:null,
    selections:[{...check.selections[0],price:null,quantity:null}]}]});
  expect(x.normalized?.netSalesCents).toBe(0);
  expect(x.warnings).toMatchObject({missing_check_amount:1,missing_tax_amount:1,
    missing_selection_price:1,missing_quantity:1});
 });
 it("excludes test and excess-food transactions",()=>{
  for(const flag of ["createdInTestMode","excessFood"]){
   const x=parse({...order,[flag]:true});
   expect(x.normalized).toBeNull();
   expect(x.voids).toHaveLength(0);
  }
 });
});


describe("Toast PR1 edge-case financial fixtures",()=>{
 it("subtracts fundraising but not ordinary service charges or gratuity",()=>{
  const x=parse({...order,checks:[{...check,amount:20,
   appliedServiceCharges:[
    {chargeAmount:4,serviceChargeCategory:"FUNDRAISING_CAMPAIGN",gratuity:false},
    {chargeAmount:2,serviceChargeCategory:"SERVICE_CHARGE",gratuity:false},
    {chargeAmount:3,serviceChargeCategory:"SERVICE_CHARGE",gratuity:true}
   ]}]});
  expect(x.normalized?.netSalesCents).toBe(1600);
  expect(x.serviceChargesCents).toBe(200);
  expect(x.gratuityCents).toBe(300);
 });
 it("uses non-tax discount only for tax-inclusive selections",()=>{
  const included={...check.selections[0],taxInclusion:"INCLUDED",
   appliedDiscounts:[{discountAmount:2.25,nonTaxDiscountAmount:2}]};
  const excluded={...check.selections[0],taxInclusion:"NOT_INCLUDED",
   appliedDiscounts:[{discountAmount:3,nonTaxDiscountAmount:1}]};
  const a=parse({...order,checks:[{...check,selections:[included]}]});
  const b=parse({...order,checks:[{...check,selections:[excluded]}]});
  expect(a.normalized?.discountsCents).toBe(200);
  expect(a.normalized?.grossSalesCents).toBe(1200);
  expect(b.normalized?.discountsCents).toBe(300);
 });
 it("subtracts deferred gift cards and house account payments exactly once",()=>{
  const first={...check.selections[0],guid:"11111111-1111-4111-8111-111111111111",
   deferred:true,price:8};
  const second={...check.selections[0],guid:"22222222-2222-4222-8222-222222222222",
   selectionType:"HOUSE_ACCOUNT_PAY_BALANCE",price:7};
  const regular={...check.selections[0],guid:"33333333-3333-4333-8333-333333333333",price:15};
  const result=parse({...order,checks:[{...check,amount:30,selections:[first,second,regular]}]});
  expect(result.normalized?.netSalesCents).toBe(1500);
  expect(result.normalized?.lines).toHaveLength(1);
  expect(result.normalized?.lines[0].netSalesCents).toBe(1500);
 });
 it("does not count voided, denied, cancelled or errored payment tips",()=>{
  const result=parse({...order,checks:[{...check,payments:[
    {paymentStatus:"CAPTURED",tipAmount:2,refund:{refundAmount:0,tipRefundAmount:0.5}},
    {paymentStatus:"VOIDED",tipAmount:8},
    {paymentStatus:"DENIED",tipAmount:8},
    {paymentStatus:"CANCELLED",tipAmount:8},
    {paymentStatus:"ERROR_NETWORK",tipAmount:8},
    {paymentStatus:"PAID",voided:true,tipAmount:8}
  ]}]});
  expect(result.normalized?.tipCents).toBe(150);
 });
 it("uses Toast business date across the spring and fall DST boundaries",()=>{
  for(const [openedDate,expected] of [
   ["2026-03-08T03:30:00-0700","2026-03-07"],
   ["2026-11-01T01:30:00-0700","2026-10-31"],
   ["2026-11-01T01:30:00-0800","2026-10-31"]
  ]){
   const result=parseToastBusinessOrder({...order,businessDate:null,openedDate},
     restaurant,expected,"America/Los_Angeles",4);
   expect(result.normalized).not.toBeNull();
   expect(result.warnings.business_date_fallback).toBe(1);
  }
 });
});
