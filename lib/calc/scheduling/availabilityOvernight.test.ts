import {describe,it,expect} from "vitest";
import {availabilityStatus,bestFreePerson,overlapsEmployeeShift,previewShift} from "./schedulePresentation";
import {shiftCost} from "./shiftCost";
import {DEFAULT_TEAM_RULES} from "./teamRuleDefaults";

describe("overnight employee schedule collision",()=>{
 const amy={id:"amy",name:"Amy",role:"Barista",wageCents:1800,minWeeklyMinutes:null,
  maxWeeklyMinutes:null,availableDays:null,colorIndex:0};
 const old={...shiftCost({employeeId:"amy",date:"2026-10-26",start:"22:00",end:"02:00",
  overnight:true,breakMinutes:0,wageCents:1800}),id:"night",employeeName:"Amy"};
 it("blocks a next-day morning shift overlapping the prior night",()=>{
  expect(overlapsEmployeeShift("amy","2026-10-27","01:00","03:00",[old])).toBe(true);
  expect(availabilityStatus(amy,"2026-10-27","01:00","03:00",[old],[])).toBe("on_shift");
  expect(bestFreePerson([amy],"2026-10-27","01:00","03:00",[old],[])).toBeNull();
 });
 it("does not count last week's overnight shift toward this week's labor but still warns on overlap",()=>{
  const preview=previewShift({employeeId:"amy",date:"2026-10-27",start:"01:00",
   end:"03:00",breakMinutes:0,editingId:null},[amy],[],[],[],
   DEFAULT_TEAM_RULES,"America/Los_Angeles",[old]);
  expect(preview).toMatchObject({before:0,overlapDetected:true,shortRest:true,availability:"on_shift"});
 });
 it("allows shifts that start after the prior one ends",()=>{
  expect(overlapsEmployeeShift("amy","2026-10-27","03:00","07:00",[old])).toBe(false);
 });
});
