import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {classifyToastOrder} from "./adapter";
import {planModifiedWindow,scheduleRefreshWindow} from "./poll";
const restaurant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orderId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base={
 guid:orderId,modifiedDate:"2026-10-12T18:00:00Z",closedDate:"2026-10-11T17:00:00Z",
 checks:[{amount:10,taxAmount:0,paymentStatus:"CLOSED",
 closedDate:"2026-10-11T17:00:00Z",selections:[{displayName:"Coffee",quantity:1,price:10}],
 payments:[{tipAmount:0,refundStatus:"NONE"}]}]
};
describe("Toast P0 state and cursor correctness",()=>{
 it("completed -> reopened -> voided -> deleted cannot leave an active completed record",()=>{
  const completed=classifyToastOrder(base,restaurant);
  expect(completed.state).toBe("completed");
  expect(completed.normalizedOrder?.netSalesCents).toBe(1000);
  for(const [change,state] of [
    [{checks:[{...base.checks[0],paymentStatus:"OPEN"}]},"reopened"],
    [{voided:true},"voided"],[{deleted:true},"deleted"],
    [{checks:[{...base.checks[0],selections:[{...base.checks[0].selections[0],refundDetails:{refundAmount:2}}]}]},"refunded"],
  ] as const) {
   const changed=classifyToastOrder({...base,...change},restaurant);
   expect(changed.state).toBe(state);
   expect(changed.normalizedOrder).toBeNull();
   expect(changed.orderGuid).toBe(completed.orderGuid);
  }
 });
 it("does not silently fast-forward more than 30 days of missing modifications",()=>{
  const now=new Date("2026-10-12T19:00:00Z");
  expect(planModifiedWindow("2026-09-01T19:00:00Z",now))
   .toMatchObject({status:"requires_historical_backfill",range:null});
  const backlog=planModifiedWindow("2026-10-11T19:00:00Z",now);
  expect(backlog.status).toBe("recoverable_backlog");
  expect(backlog.range?.since.toISOString()).toBe("2026-10-11T18:58:00.000Z");
  expect(backlog.range!.until.getTime()-backlog.range!.since.getTime()).toBeLessThanOrEqual(7*60000);
 });
 it("plans schedule refresh before opening across fall DST with bounded horizon",()=>{
   const t=scheduleRefreshWindow(new Date("2026-11-01T07:30:00Z"),
     "America/Los_Angeles",14);
   expect(t.since.getTime()).toBeLessThan(Date.parse("2026-11-01T07:30:00Z"));
   expect(t.until.getTime()).toBeGreaterThan(Date.parse("2026-11-01T07:30:00Z"));
   expect(t.until.getTime()-t.since.getTime()).toBeLessThan(30*86400000);
 });
 it("keeps different schedule and modified-order time windows",()=>{
   const now=new Date("2026-10-12T19:00:00Z");
   const m=planModifiedWindow("2026-10-12T18:30:00Z",now).range!;
   const s=scheduleRefreshWindow(now,"America/Los_Angeles",14);
   expect(s.until.getTime()-s.since.getTime()).toBeGreaterThan(m.until.getTime()-m.since.getTime());
 });
});
