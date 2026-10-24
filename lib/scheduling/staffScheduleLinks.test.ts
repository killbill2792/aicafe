import {describe,it,expect} from "vitest";
import {staffScheduleHref,scheduleWeekForDate,validScheduleDate,staffManageRedirectQuery,resolveDatedStaffShift} from "./staffScheduleLinks";
describe("staff schedule links",()=>{
 it("opens the requested week and retains the selected date and person",()=>{
  expect(scheduleWeekForDate("2026-10-29","2026-10-19","2026-10-26")).toBe("2026-10-26");
  expect(staffScheduleHref({date:"2026-10-29",employee:"person & 2"})).toBe("/staff?tab=schedule&date=2026-10-29&employee=person+%26+2");
 });
 it("rejects impossible dates instead of opening the wrong week",()=>{
  expect(validScheduleDate("2026-02-30")).toBe(false);
  expect(validScheduleDate("2026-10-29")).toBe(true);
  expect(scheduleWeekForDate("2026-02-30","2026-10-22","2026-10-19")).toBe("2026-10-19");
  expect(staffScheduleHref({date:"2026-13-90",employee:"someone"})).toBe("/staff?tab=schedule&employee=someone");
 });
 it("resolves only the target person's shift and refuses a clock mismatch",()=>{
  const dates=["2026-10-26","2026-10-27"];
  const people=[{id:"alice"},{id:"bob"}];
  const shifts=[{id:"a",employeeId:"alice",date:dates[0],start:"06:15"},{id:"b",employeeId:"bob",date:dates[0],start:"07:15"}];
  expect(resolveDatedStaffShift(dates,people,shifts,dates[0],"alice")?.shift?.id).toBe("a");
  expect(resolveDatedStaffShift(dates,people,shifts,dates[0],"alice","08:00")?.shift).toBeUndefined();
  expect(resolveDatedStaffShift(dates,people,shifts,dates[1],"alice")?.shift).toBeUndefined();
  expect(resolveDatedStaffShift(dates,people,shifts,"2026-10-28","alice")).toBeNull();
  expect(resolveDatedStaffShift(dates,people,shifts,dates[0],"ghost")).toBeNull();
 });
 it("keeps the employee and date on the legacy redirect",()=>{
  expect(staffManageRedirectQuery({employee:"alice",date:"2026-10-29"})).toEqual({tab:"schedule",date:"2026-10-29",employee:"alice"});
  expect(staffManageRedirectQuery({employee:"alice",tab:"team"})).toEqual({tab:"team",employee:"alice"});
  expect(staffManageRedirectQuery({date:"2026-02-30",tab:"schedule"})).toEqual({tab:"schedule"});
 });
 it("falls back to the selected local week, not the host clock",()=>{
  expect(scheduleWeekForDate(undefined,undefined,"2026-10-26")).toBe("2026-10-26");
 });
});
