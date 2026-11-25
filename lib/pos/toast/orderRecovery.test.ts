import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {orderRecoveryCadence,orderRecoveryWindow} from "./orderRecovery";
describe("webhook-primary incremental fallback",()=>{
 it("uses the same five-minute live recovery even with a configured webhook",()=>{
  expect(orderRecoveryCadence(true,false)).toBe(300000);
  expect(orderRecoveryCadence(true,true)).toBe(300000);
  expect(orderRecoveryCadence(false,false)).toBe(900000);
  expect(orderRecoveryCadence(false,true)).toBe(900000);
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
