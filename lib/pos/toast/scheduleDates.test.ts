import {describe,it,expect} from "vitest";
import {addCalendarDays,deriveNextRunDay,eligibleClosedDay,localClock} from "./scheduleDates";
describe("Toast cron local calendar boundaries: acceptance 13",()=>{
 it("schedules October 31 exactly once after fallback closeout+1",()=>{
  const justBefore=new Date("2026-11-01T12:59:00Z");
  const due=new Date("2026-11-01T13:00:00Z");
  expect(localClock(justBefore,"America/Los_Angeles").minutes).toBe(299);
  expect(eligibleClosedDay(justBefore,"America/Los_Angeles",4)).toBeNull();
  expect(eligibleClosedDay(due,"America/Los_Angeles",4)).toBe("2026-10-31");
  expect(eligibleClosedDay(new Date("2026-11-01T14:00:00Z"),
   "America/Los_Angeles",4)).toBe("2026-10-31");
 });
 it("does not double-fire after the spring-forward clock transition",()=>{
  expect(eligibleClosedDay(new Date("2027-03-08T11:59:00Z"),
   "America/Los_Angeles",4)).toBeNull();
  expect(eligibleClosedDay(new Date("2027-03-08T12:00:00Z"),
   "America/Los_Angeles",4)).toBe("2027-03-07");
 });
});
describe("multi-day resume never trusts erased SQL cursor",()=>{
 it("resolves day three after two durable commits and after a 429",()=>{
  const r={requested_from:"2026-10-01",requested_to:"2026-10-10",days_done:2,
   cursor:{business_date:"2026-10-03",page:2}};
  expect(deriveNextRunDay(r)).toBe("2026-10-03");
  r.cursor={business_date:"2026-10-03",page:1};
  expect(deriveNextRunDay({...r,days_done:3})).toBe("2026-10-04");
  expect(deriveNextRunDay({...r,days_done:10})).toBeNull();
 });
 it("handles calendar transitions without assuming every local day is 24 hours",()=>{
  expect(addCalendarDays("2026-10-31",1)).toBe("2026-11-01");
  expect(addCalendarDays("2027-03-13",1)).toBe("2027-03-14");
 });
});
