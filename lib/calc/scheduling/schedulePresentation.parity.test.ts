import {describe,it,expect} from "vitest";
import {shiftCost,costCompleteness} from "./shiftCost";
import {dayTotals,personTotals,projectVisibleStaffWeek} from "./schedulePresentation";
import {reconcileStaffCalendar,type CalendarEntry} from "./calendarEntries";

const olivia={...shiftCost({employeeId:"amy",date:"2026-11-09",start:"09:00",
 end:"17:00",breakMinutes:0,wageCents:2000}),id:"approved-olivia",
 employeeName:"Amy",source:"olivia",status:"draft"};
const entry=(id:string,date:string,start:string,end:string,
 source:CalendarEntry["source"]):CalendarEntry=>({
 id,employeeId:"amy",employeeName:"Amy",date,start,end,source
});
describe("Staff grid day, worker and week labor parity",()=>{
 it("counts approved Olivia hours and wages exactly once across all totals",()=>{
  const calendarEntries=reconcileStaffCalendar([
   entry("ai-supervisor:approved-olivia","2026-11-09","09:00","17:00","ai_draft")]);
  const projection=projectVisibleStaffWeek({shifts:[olivia],calendarEntries});
  const day=dayTotals("2026-11-09",projection.laborShifts);
  const person=personTotals("amy",projection.laborShifts);
  expect([day.paidMinutes,person.paidMinutes,projection.total.paidMinutes])
   .toEqual([480,480,480]);
  expect([day.knownCostCents,person.knownCostCents,projection.total.knownCostCents])
   .toEqual([16000,16000,16000]);
  expect(projection.drawnShifts).toEqual([]);
  expect(projection.visible).toMatchObject([{source:"ai_draft",paidMinutes:480,
   costCents:16000}]);
 });
 it("Toast with different hours hides superseded drafts and leaves labor unknown",()=>{
  const toast=entry("toast-planned","2026-11-09","10:00","18:00","toast_planned");
  const projection=projectVisibleStaffWeek({shifts:[olivia],
   calendarEntries:reconcileStaffCalendar([
    entry("ai-supervisor:approved-olivia","2026-11-09","09:00","17:00","ai_draft"),toast])});
  expect(projection.visible).toMatchObject([{id:"toast-planned",start:"10:00",
   end:"18:00",paidMinutes:null,costCents:null,source:"toast"}]);
  expect(projection.laborShifts).toEqual([]);
  expect(projection.total.knownCostCents).toBe(0);
  expect(projection.hoursComplete).toBe(false);
  expect(projection.costComplete).toBe(false);
  expect(costCompleteness({...projection.total,unknownCount:
   projection.total.unknownCount+Number(!projection.costComplete)})).toBe("unknown");
 });
 it("does not exclude Olivia revision drafts on days without Toast",()=>{
  const projection=projectVisibleStaffWeek({shifts:[],calendarEntries:[
   entry("revision-1","2026-11-10","08:00","12:00","ai_draft")]});
  expect(projection.visible).toMatchObject([{id:"revision-1",source:"ai_draft",
   paidMinutes:null,costCents:null}]);
  expect(projection.hoursComplete).toBe(true);
 });
});