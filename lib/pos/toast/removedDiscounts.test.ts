import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {isRemovedToastDiscount,parseToastBusinessOrder} from "./dayParser";
import {summarizeToastToday} from "./todaySoFar";

const restaurant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const day="2026-11-02";
const disc=(guid:string,processingState:string|null)=>({guid,name:"Dental Students & Faculty",
 discountType:"PERCENT",discountPercent:10,discountAmount:0.88,nonTaxDiscountAmount:0.88,processingState});
// The real Nov 2 shape: the student discount applied, removed (VOID) and applied
// again on the Banana Bread Matcha; once on the Cinnamon Roll Matcha.
const order={guid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",businessDate:20261102,
 openedDate:"2026-11-02T13:32:30.000-0800",modifiedDate:"2026-11-02T21:40:00.000+0000",
 checks:[{guid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",paymentStatus:"CLOSED",amount:15.74,taxAmount:0,
  appliedDiscounts:[],payments:[],
  selections:[
   {guid:"cccccccc-cccc-4ccc-8ccc-000000000001",displayName:"Banana Bread Matcha",quantity:1,
    preDiscountPrice:8.75,price:7.87,taxInclusion:"NOT_INCLUDED",
    appliedDiscounts:[disc("eeeeeeee-eeee-4eee-8eee-000000000001","VOID"),disc("eeeeeeee-eeee-4eee-8eee-000000000002",null)]},
   {guid:"cccccccc-cccc-4ccc-8ccc-000000000002",displayName:"Cinnamon Roll Matcha",quantity:1,
    preDiscountPrice:8.75,price:7.87,taxInclusion:"NOT_INCLUDED",
    appliedDiscounts:[disc("eeeeeeee-eeee-4eee-8eee-000000000003",null)]}]}]};
const parse=(o:unknown)=>parseToastBusinessOrder(o,restaurant,day,"America/Los_Angeles",4).normalized!;

describe("a discount removed at the register is not counted (as in Toast's reports)",()=>{
 it("recognises only Toast's VOID state",()=>{
  expect(isRemovedToastDiscount({processingState:"VOID"})).toBe(true);
  expect(isRemovedToastDiscount({processingState:null})).toBe(false);
  expect(isRemovedToastDiscount({processingState:"APPLIED"})).toBe(false);
  expect(isRemovedToastDiscount({})).toBe(false);
  expect(isRemovedToastDiscount(null)).toBe(false);
 });

 it("counts the two applied student discounts, not the removed one ($1.76, not $2.64)",()=>{
  const x=parse(order);
  expect(x.discountsCents).toBe(176);
  expect(x.grossSalesCents).toBe(1574+176);
 });

 it("never changes net sales",()=>{
  const without={...order,checks:[{...order.checks[0],selections:order.checks[0].selections.map(s=>
   ({...s,appliedDiscounts:s.appliedDiscounts.filter(d=>d.processingState!=="VOID")}))}]};
  expect(parse(order).netSalesCents).toBe(1574);
  expect(parse(order)).toEqual(parse(without));
 });

 it("skips a removed check-level discount too",()=>{
  const x=parse({...order,checks:[{...order.checks[0],selections:[],amount:10,
   appliedDiscounts:[{discountAmount:5,processingState:"VOID"},{discountAmount:1,processingState:null}]}]});
  expect(x.discountsCents).toBe(100);
 });

 it("today's live total uses the same rule",()=>{
  const page={orders:[parseToastBusinessOrder(order,restaurant,day,"America/Los_Angeles",4)],unparsed:[]};
  const t=summarizeToastToday({businessDate:day,readAt:"2026-11-02T22:00:00.000Z",
   pages:[page as never],locationsRead:1,locationsFailed:0,truncated:false});
  expect(t.discountsCents).toBe(176);
 });
});
