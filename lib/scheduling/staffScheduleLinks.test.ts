import {describe,it,expect} from "vitest";
import {staffScheduleHref,scheduleWeekForDate,validScheduleDate,staffManageRedirectQuery} from "./staffScheduleLinks";
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
 it("keeps the employee and date on the legacy redirect",()=>{
  expect(staffManageRedirectQuery({employee:"alice",date:"2026-10-29"})).toEqual({tab:"schedule",date:"2026-10-29",employee:"alice"});
  expect(staffManageRedirectQuery({employee:"alice",tab:"team"})).toEqual({tab:"team",employee:"alice"});
  expect(staffManageRedirectQuery({date:"2026-02-30",tab:"schedule"})).toEqual({tab:"schedule"});
 });
 it("falls back to the selected local week, not the host clock",()=>{
  expect(scheduleWeekForDate(undefined,undefined,"2026-10-26")).toBe("2026-10-26");
 });
});
