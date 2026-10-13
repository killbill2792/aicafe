import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {isCafeCurrentlyOpen} from "./poll";
import {readFileSync} from "node:fs";
const timezone="America/Los_Angeles";
describe("Toast safe open-hours polling",()=>{
 it("skips unknown or explicitly closed hours",()=>{
  expect(isCafeCurrentlyOpen(null,timezone,new Date("2026-10-12T17:00:00Z"))).toBe(false);
  expect(isCafeCurrentlyOpen({mon:[]},timezone,new Date("2026-10-12T17:00:00Z"))).toBe(false);
 });
 it("checks the café timezone, not UTC date or assumed operating hours",()=>{
  const hours={mon:[["08:00","15:00"] as [string,string]]};
  expect(isCafeCurrentlyOpen(hours,timezone,new Date("2026-10-12T17:00:00Z"))).toBe(true);
  expect(isCafeCurrentlyOpen(hours,timezone,new Date("2026-10-12T06:00:00Z"))).toBe(false);
 });
 it("handles overnight shifts and DST boundary using local calendar time",()=>{
  const hours={sat:[["22:00","02:00"] as [string,string]]};
  // Nov 1, 2026 01:30 PDT/PST both lie inside Saturday overnight hours.
  expect(isCafeCurrentlyOpen(hours,timezone,new Date("2026-11-01T08:30:00Z"))).toBe(true);
  expect(isCafeCurrentlyOpen(hours,timezone,new Date("2026-11-01T09:30:00Z"))).toBe(true);
 });
 it("requires a tenant-scoped Postgres claim/finish lease, no cron changes",()=>{
  const sql=readFileSync("supabase/migrations/20261012000050_toast_poll_leases.sql","utf8");
  expect(sql).toContain("lease_nonce=p_nonce");
  expect(sql).toContain("toast_claim_poll");
  expect(sql).toContain("TO service_role");
 });
});
