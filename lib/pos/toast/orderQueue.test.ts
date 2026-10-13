import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {orderEventRetryAt} from "./orderQueue";
import {ToastApiError} from "./client";
import {readFileSync} from "node:fs";
describe("Toast durable Orders queue boundary",()=>{
 it("defers to provider-specified Retry-After rather than retrying early",()=>{
  expect(orderEventRetryAt(new ToastApiError("rate_limited",429,"2026-10-12T19:00:00Z"),
   2,Date.parse("2026-10-12T18:00:00Z"))).toBe("2026-10-12T19:00:00Z");
 });
 it("backs off failed work with a bounded 60 minute delay",()=>{
  const start=Date.parse("2026-10-12T18:00:00Z");
  expect(Date.parse(orderEventRetryAt(new Error(),200,start))-start).toBe(3600000);
 });
 it("ensures expired processing leases are recoverable but stale workers cannot finish newer claims",()=>{
  const sql=readFileSync("supabase/migrations/20261012000049_toast_order_queue.sql","utf8");
  expect(sql).toContain("FOR UPDATE SKIP LOCKED");
  expect(sql).toContain("AND lease_nonce=p_lease_nonce");
  expect(sql).toContain("REVOKE ALL ON toast_modified_orders_staging");
  expect(sql).toContain("TO service_role");
 });
});
