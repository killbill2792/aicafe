import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {orderRecoveryCadence,orderRecoveryWindow,toastShouldPollOrders,prepareIncrementalOrderPage} from "./orderRecovery";
describe("webhook-primary incremental fallback",()=>{
 it("uses the same ten-minute live recovery even with a configured webhook",()=>{
  expect(orderRecoveryCadence(true,false)).toBe(600000);
  expect(orderRecoveryCadence(true,true)).toBe(600000);
  expect(orderRecoveryCadence(false,false)).toBe(Infinity);
  expect(orderRecoveryCadence(false,true)).toBe(Infinity);
 });
 it("recovers a missed month without jumping to recent dates",()=>{
  const cursor="2026-10-01T08:00:00Z";
  const result=orderRecoveryWindow(cursor,new Date("2026-11-25T08:00:00Z"),new Date("2026-11-25T10:00:00Z"));
  expect(result?.since.toISOString()).toBe("2026-10-01T07:58:00.000Z");
  expect(result?.until.toISOString()).toBe("2026-10-01T09:00:00.000Z");
 });
 it("keeps overlap and delays the newest two minutes",()=>{
  const result=orderRecoveryWindow("2026-11-25T09:50:00Z",new Date("2026-11-25T08:00:00Z"),new Date("2026-11-25T10:00:00Z"));
  expect(result?.since.toISOString()).toBe("2026-11-25T09:48:00.000Z");
  expect(result?.until.toISOString()).toBe("2026-11-25T09:58:00.000Z");
  expect(orderRecoveryWindow("2026-11-25T09:58:00Z",new Date("2026-11-25T08:00:00Z"),new Date("2026-11-25T10:00:00Z"))).toBeNull();
 });
});

it("stops known closed hours after one closing catch-up; unknown hours stay live",()=>{
 const hours={mon:[["08:00","16:00"]] as [string,string][]};
 const now=new Date("2026-11-24T00:10:00Z");
 expect(toastShouldPollOrders(hours,"America/Los_Angeles",now,"2026-11-23T23:58:00Z")).toBe(true);
 expect(toastShouldPollOrders(hours,"America/Los_Angeles",now,"2026-11-24T00:08:00Z")).toBe(false);
 expect(toastShouldPollOrders(null,"America/Los_Angeles",now,null)).toBe(true);
});

it("isolates bad identity, date, timestamp and wrong-day rows from valid revisions",()=>{
 const scope={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",timezone:"America/Los_Angeles",closeoutHour:4};
 const good={guid:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",businessDate:20261124,modifiedDate:"2026-11-25T10:00:00Z",checks:[]};
 const result=prepareIncrementalOrderPage(scope,[{...good,guid:null},good,{...good,businessDate:20260231},
  {...good,modifiedDate:"invalid"},{...good,businessDate:20261123}],"2026-11-24");
 expect(result.prepared).toHaveLength(1);
 expect(result.unparsed.map(x=>x.source_index)).toEqual([1,3,4,5]);
 expect(result.unparsed[0].order_guid).toBeNull();
 expect(result.unparsed.every(x=>x.raw_sha256.length===64)).toBe(true);
 expect(result.unparsed.every(x=>!("payload" in x))).toBe(true);
});
