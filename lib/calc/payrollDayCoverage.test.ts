import {describe,it,expect} from "vitest";
import {payrollDayCoverage} from "./payrollDayCoverage";
const card=(businessDate:string,wage:number|null,clockOut:string|null="2026-10-26T17:00:00Z")=>({
 businessDate,clockOut,hourlyWageCents:wage
});
const rollup=(businessDate:string,staffWagesCents:number|null=10000,taxStatus="actual")=>({
 businessDate,staffWagesCents,staffTaxCents:1200,laborWageStatus:"actual" as const,taxStatus
});
describe("completeness of canonical clocked wages and payroll tax",()=>{
 it("does not call a day complete when one of two employees has an unknown wage",()=>{
  expect(payrollDayCoverage([card("2026-10-26",2000),card("2026-10-26",null)],
   [rollup("2026-10-26")]).coveredDates.size).toBe(0);
 });
 it("requires actual closed timecards and the matching persisted daily row",()=>{
  expect(payrollDayCoverage([card("2026-10-26",2000,null)],
   [rollup("2026-10-26")]).coveredDates.size).toBe(0);
  expect(payrollDayCoverage([card("2026-10-26",2000)],[]).coveredDates.size).toBe(0);
  expect(payrollDayCoverage([card("2026-10-26",2000)],
   [rollup("2026-10-26",null)]).coveredDates.size).toBe(0);
 });
 it("does not cover known-only wages if labor_wage_status is missing",()=>{
  const day={...rollup("2026-10-26"),laborWageStatus:"missing" as const};
  expect(payrollDayCoverage([card("2026-10-26",2000)],[day]).coveredDates.size).toBe(0);
 });
 it("allows a zero explicitly recorded wage but labels estimated employer tax",()=>{
  const r=payrollDayCoverage([card("2026-10-26",0)],
   [rollup("2026-10-26",0,"estimated")]);
  expect([...r.coveredDates]).toEqual(["2026-10-26"]);
  expect([...r.taxEstimatedDays]).toEqual(["2026-10-26"]);
 });
});
