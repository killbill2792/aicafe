import {describe,expect,it} from "vitest";
import {personFields,updatePersonFields,restoreShiftInput,setPersonActiveInput,shiftInput} from "./scheduleValidators";
import {elapsedMinutes,paidMinutes,shiftCost} from "./shiftCost";
import {checkTimecardRules,localWeekStart} from "./ruleChecks";
const sample={name:"Amy",role:null,wageCents:null,
 availability:[{day:0,start:"06:00",end:"12:00"},{day:3,start:null,end:null}],
 minWeeklyMinutes:null,maxWeeklyMinutes:null,phone:null};
describe("staff profile safety",()=>{
 it("permits name-only person, per-day nullable windows, weekly nullable limits",()=>{
  expect(personFields.safeParse(sample).success).toBe(true);
  expect(updatePersonFields.safeParse({...sample,id:"d637c32d-c82c-49af-8371-b31502292727"}).success).toBe(true);
  expect(personFields.safeParse({...sample,availability:[]})).toMatchObject({success:true});
 });
 it("rejects duplicate days, partial windows and inverted min/max",()=>{
  expect(personFields.safeParse({...sample,availability:[sample.availability[0],sample.availability[0]]}).success).toBe(false);
  expect(personFields.safeParse({...sample,availability:[{day:0,start:"06:00",end:null}]}).success).toBe(false);
  expect(personFields.safeParse({...sample,minWeeklyMinutes:1800,maxWeeklyMinutes:1200}).success).toBe(false);
  expect(personFields.safeParse({...sample,phone:"not a phone"}).success).toBe(false);
  expect(personFields.safeParse({...sample,unknown:"unsafe"}).success).toBe(false);
 });
 it("restoreShift accepts only a UUID, no client rows, and deactivate requires explicit boolean",()=>{
  const id="d637c32d-c82c-49af-8371-b31502292727";
  expect(restoreShiftInput.safeParse({id}).success).toBe(true);
  expect(restoreShiftInput.safeParse({id,removed:{id}}).success).toBe(false);
  expect(setPersonActiveInput.safeParse({id,active:false}).success).toBe(true);
  expect(setPersonActiveInput.safeParse({id,active:"false"}).success).toBe(false);
 });
});
describe("schedule boundary truth",()=>{
 it("treats overnight paid minutes and costs as local elapsed hours",()=>{
  expect(elapsedMinutes("22:30","06:30",true)).toBe(480);
  expect(paidMinutes({start:"22:30",end:"06:30",overnight:true,breakMinutes:30})).toBe(450);
  expect(shiftCost({employeeId:"e",date:"2026-10-26",start:"22:30",end:"06:30",
    overnight:true,breakMinutes:30,wageCents:2000})).toMatchObject({paidMinutes:450,costCents:15000});
  expect(()=>elapsedMinutes("22:30","06:30",false)).toThrow();
  expect(shiftInput.safeParse({employeeId:"bad",date:"2026-10-26",start:"22:30",end:"06:30"}).success).toBe(false);
 });
 it("uses business-local Monday weeks across DST change",()=>{
  expect(localWeekStart("2026-11-02T07:30:00Z","America/Los_Angeles")).toBe("2026-10-26");
  expect(localWeekStart("2026-11-02T08:30:00Z","America/Los_Angeles")).toBe("2026-11-02");
  expect(localWeekStart("2026-03-09T06:30:00Z","America/Los_Angeles")).toBe("2026-03-02");
  expect(localWeekStart("2026-03-09T07:30:00Z","America/Los_Angeles")).toBe("2026-03-09");
 });
});
