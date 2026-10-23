import {describe,it,expect} from "vitest";
import {usageBusinessDay,usageWeekEnding} from "./usageDates";
describe("usage dates in the cafe timezone",()=>{
 it("uses previous LA day after UTC midnight",()=>{
  const now=new Date("2026-10-24T03:00:00Z");
  expect(usageBusinessDay(now,"America/Los_Angeles")).toBe("2026-10-23");
  expect(usageBusinessDay(now,"Asia/Dubai")).toBe("2026-10-24");
 });
 it("preserves date-only windows across DST and month/year boundaries",()=>{
  expect(usageWeekEnding("2026-03-02")).toEqual({from:"2026-02-24",to:"2026-03-02"});
  expect(usageWeekEnding("2027-01-01")).toEqual({from:"2026-12-26",to:"2027-01-01"});
 });
});