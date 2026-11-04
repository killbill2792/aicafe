import {describe,it,expect} from "vitest";
import {reconcileStaffCalendar,type CalendarEntry} from "./calendarEntries";
const entry=(id:string,date:string,source:CalendarEntry["source"]):CalendarEntry=>({
 id,employeeId:"amy",employeeName:"Amy",date,start:"08:00",end:"12:00",source
});
describe("Toast-first employee calendar",()=>{
 it("shows planned and actual together, but not even an approved AI draft for the same day",()=>{
  const entries=reconcileStaffCalendar([
   entry("draft","2026-11-09","ai_draft"),
   entry("planned","2026-11-09","toast_planned"),
   entry("actual","2026-11-09","toast_actual"),
   entry("other-draft","2026-11-10","ai_draft")]);
  expect(entries.map(e=>e.id)).toEqual(["actual","planned","other-draft"]);
  expect(entries.map(e=>e.source)).toEqual(["toast_actual","toast_planned","ai_draft"]);
 });
 it("shows past week Toast evidence without a current-week filter",()=>{
  expect(reconcileStaffCalendar([entry("old","2026-10-19","toast_actual")])[0].date)
   .toBe("2026-10-19");
 });
});