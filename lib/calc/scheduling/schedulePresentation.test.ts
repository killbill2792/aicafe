import {describe,expect,it} from "vitest";
import {availabilityStatus,bestFreePerson,peopleWithRetainedShifts,type PersonForSchedule,type AvailabilityEntry}
 from "./schedulePresentation";

const person:PersonForSchedule={id:"amy",name:"Amy",role:"Barista",wageCents:1900,
 minWeeklyMinutes:null,maxWeeklyMinutes:null,availableDays:[1],colorIndex:null};
const rule=(start:string,end:string):AvailabilityEntry=>({
 employee_id:"amy",day_of_week:1,start_local:start,end_local:end,
 effective_from:"2026-10-01",effective_to:null
});
describe("dated availability and roster presentation",()=>{
 it("accepts an afternoon slot in a second same-day window",()=>{
  const windows=[rule("06:00","10:00"),rule("14:00","18:00")];
  expect(availabilityStatus(person,"2026-10-26","14:00","17:00",[],windows)).toBe("free");
  expect(bestFreePerson([person],"2026-10-26","14:00","17:00",[],windows)?.id).toBe("amy");
  expect(availabilityStatus(person,"2026-10-26","09:00","15:00",[],windows)).toBe("unavailable");
 });
 it("combines touching windows while refusing an uncovered gap",()=>{
  const windows=[rule("06:00","10:00"),rule("10:00","14:00")];
  expect(availabilityStatus(person,"2026-10-26","09:00","12:00",[],windows)).toBe("free");
  expect(availabilityStatus(person,"2026-10-26","09:00","15:00",[],windows)).toBe("unavailable");
 });
 it("retains inactive employees who have dated shifts but not unscheduled alumni",()=>{
  const roster=[{id:"active",active:true},{id:"former",active:false},{id:"departed",active:false}];
  expect(peopleWithRetainedShifts(roster,[{employeeId:"former"}]))
    .toEqual([roster[0],roster[1]]);
 });
});
