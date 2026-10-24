import {describe,it,expect} from "vitest";
import {validShiftClock,scheduledShiftMinutes,parseUnpaidBreakMinutes} from "./shiftInput";
describe("shift input validation",()=>{
 it("accepts any minute, including overnight",()=>{
  expect(validShiftClock("06:15")).toBe(true);
  expect(scheduledShiftMinutes("21:15","03:05")).toBe(350);
  expect(scheduledShiftMinutes("06:15","07:16")).toBe(61);
 });
 it("rejects impossible and zero-length times",()=>{
  for(const value of ["6:15","24:00","23:60",""])expect(validShiftClock(value)).toBe(false);
  expect(scheduledShiftMinutes("07:00","07:00")).toBeNull();
  expect(scheduledShiftMinutes("","17:00")).toBeNull();
 });
 it("does not silently coerce invalid unpaid breaks to zero",()=>{
  expect(parseUnpaidBreakMinutes("31",480)).toBe(31); 
  expect(parseUnpaidBreakMinutes("٣١",480)).toBe(31); 
  expect(parseUnpaidBreakMinutes("۳۱",480)).toBe(31);
  for(const bad of ["","-1","2.5","241","0010.5"])expect(parseUnpaidBreakMinutes(bad,480)).toBeNull();
  expect(parseUnpaidBreakMinutes("60",60)).toBeNull();
  expect(parseUnpaidBreakMinutes("0",null)).toBeNull();
 });
});
