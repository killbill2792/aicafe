import {describe,it,expect} from "vitest";
import {canStartToastImport,canRepullToastDay} from "./toastOwnerActionState";
describe("owner sees only actionable Toast import controls",()=>{
 it("setup enabled without auto-import does not allow the owner to launch a dead-end import",()=>{
  expect(canStartToastImport(false,false,"2026-10-01","2026-10-23")).toBe(false);
  expect(canRepullToastDay(false,false,"2026-10-01","2026-10-23",[])).toBe(false);
 });
 it("import activated permits yesterday but rejects today and partial invalid dates",()=>{
  expect(canStartToastImport(true,false,"2026-10-23","2026-10-23")).toBe(true);
  expect(canStartToastImport(true,false,"2026-10-24","2026-10-23")).toBe(false);
  expect(canStartToastImport(true,false,"","2026-10-23")).toBe(false);
  expect(canStartToastImport(true,false,"2015-12-01","2026-10-23")).toBe(false);
  expect(canRepullToastDay(true,false,"2026-10-23","2026-10-23",[])).toBe(true);
  expect(canRepullToastDay(true,false,"2026-10-24","2026-10-23",[])).toBe(false);
 });
 it("disables queued or in-flight submissions without blocking other days",()=>{
  const ranges=[{from:"2026-10-10",to:"2026-10-20"}];
  expect(canRepullToastDay(true,false,"2026-10-16","2026-10-23",ranges)).toBe(false);
  expect(canRepullToastDay(true,false,"2026-10-21","2026-10-23",ranges)).toBe(true);
  expect(canRepullToastDay(true,true,"2026-10-21","2026-10-23",ranges)).toBe(false);
  expect(canStartToastImport(true,true,"2026-10-01","2026-10-23")).toBe(false);
 });
});
