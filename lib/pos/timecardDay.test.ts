import {describe,expect,it} from "vitest";
import {affectedLocalDays,timecardWagesForLocalDay} from "./timecardDay";
const zone="America/Los_Angeles";
const later=new Date("2026-12-01T00:00:00Z");
describe("actual paid time across café-local day boundaries",()=>{
 it("splits an overnight shift; each day sees only its own paid hours",()=>{
  const shift={clockIn:"2026-10-27T06:00:00Z",clockOut:"2026-10-27T09:00:00Z",
    hourlyWageCents:2000,breaks:[]}; // Oct 26 23:00 -> Oct 27 02:00 PDT
  expect(affectedLocalDays(shift.clockIn,shift.clockOut!,zone))
   .toEqual(["2026-10-26","2026-10-27"]);
  expect(timecardWagesForLocalDay(shift,"2026-10-26",zone,later)).toBe(2000);
  expect(timecardWagesForLocalDay(shift,"2026-10-27",zone,later)).toBe(4000);
 });
 it("subtracts only the unpaid break duration occurring on the day",()=>{
  const shift={clockIn:"2026-10-27T06:00:00Z",clockOut:"2026-10-27T09:00:00Z",
    hourlyWageCents:2000,
    breaks:[{start:"2026-10-27T06:45:00Z",end:"2026-10-27T07:15:00Z",paid:false}]};
  expect(timecardWagesForLocalDay(shift,"2026-10-26",zone,later)).toBe(1500);
  expect(timecardWagesForLocalDay(shift,"2026-10-27",zone,later)).toBe(3500);
 });
 it("keeps unknown wage unknown rather than an observed zero",()=>{
  expect(timecardWagesForLocalDay({clockIn:"2026-10-27T06:00:00Z",
   clockOut:"2026-10-27T09:00:00Z",hourlyWageCents:null},
    "2026-10-26",zone,later)).toBeNull();
 });
 it("does not double-count a shift ending exactly at local midnight",()=>{
  expect(affectedLocalDays("2026-10-26T21:00:00Z","2026-10-27T07:00:00Z",zone))
   .toEqual(["2026-10-26"]);
 });
 it("counts the additional real hour on the 2026 fall DST boundary",()=>{
  const shift={clockIn:"2026-11-01T07:30:00Z",clockOut:"2026-11-01T10:30:00Z",
   hourlyWageCents:1000,breaks:[]};
  expect(affectedLocalDays(shift.clockIn,shift.clockOut!,zone)).toEqual(["2026-11-01"]);
  expect(timecardWagesForLocalDay(shift,"2026-11-01",zone,later)).toBe(3000);
 });
 it("includes both old and corrected intervals when an importer recomputes dates",()=>{
  const old=affectedLocalDays("2026-10-27T06:00:00Z","2026-10-27T09:00:00Z",zone);
  const corrected=affectedLocalDays("2026-10-27T08:00:00Z","2026-10-27T11:00:00Z",zone);
  expect([...new Set([...old,...corrected])].sort()).toEqual(["2026-10-26","2026-10-27"]);
 });
});
