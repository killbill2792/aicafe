import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {prepareToastOrderRevision,sameOrOlderOrder,sourceOrderDay} from "./orderIngestion";
const scope={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",timezone:"America/Los_Angeles",closeoutHour:4};
const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const order={guid:id,businessDate:20261124,modifiedDate:"2026-11-25T10:00:00.000+0000",checks:[{guid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",paymentStatus:"CLOSED"}]};
describe("webhook and incremental order revision identity",()=>{
 it("does not confuse provider modification date with the original business date",()=>{
  expect(sourceOrderDay(order,scope)).toBe("2026-11-24");
  expect(sourceOrderDay({...order,businessDate:null,openedDate:"2026-11-25T10:00:00.000+0000"},scope)).toBe("2026-11-24");
 });
 it("rejects invalid business dates and missing modification evidence",()=>{
  expect(()=>sourceOrderDay({...order,businessDate:20260231},scope)).toThrow();
  expect(()=>sourceOrderDay({...order,modifiedDate:"invalid"},scope)).toThrow();
 });
 it("sends the original permitted order without copying provisional figures",()=>{
  const payload={...order,checks:[{...order.checks[0],amount:12.50}],newField:{value:null}};
  expect(prepareToastOrderRevision(scope,payload)).toEqual({day:"2026-11-24",payload});
 });
 it("keeps parse failure evidence beside the original order",()=>{
  const payload={...order,checks:[{...order.checks[0],amount:"incorrect type"}]};
  expect(prepareToastOrderRevision(scope,payload)).toEqual({day:"2026-11-24",payload,parseFailed:true});
 });
 it("deduplicates identical records regardless of JSON key ordering",()=>{
  expect(sameOrOlderOrder(order,{checks:order.checks,modifiedDate:order.modifiedDate,businessDate:order.businessDate,guid:id})).toBe(true);
 });
 it("ignores an older event but preserves a genuine change at the same revision",()=>{
  expect(sameOrOlderOrder(order,{...order,modifiedDate:"2026-11-25T09:00:00.000Z"})).toBe(true);
  expect(sameOrOlderOrder(order,{...order,checks:[{...order.checks[0],paymentStatus:"VOIDED"}]})).toBe(false);
  expect(sameOrOlderOrder(order,{...order,guid:scope.businessId})).toBe(false);
 });
});
