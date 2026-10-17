import {describe,it,expect} from "vitest";
import {matchesOwnerScheduleDates as matches} from "./whatIfOwnerDates";
const input=(day:string,week="2026-10-19")=>({week,overrides:[{localDate:day}]});
describe("Owner-authored scheduling calendar constraints",()=>{
  it("binds explicit dates before any canonical read",()=>{
    expect(matches(input("2026-10-20"),"Ava absent 2026-10-20","2026-10-19")).toBe(true);
    expect(matches(input("2026-10-27","2026-10-26"),"Ava absent 2026-10-20","2026-10-19")).toBe(false);
    expect(matches(input("2026-10-20","2026-10-26"),"Ava absent 2026-10-20","2026-10-19")).toBe(false);
  });
  it.each(["Tuesday","martes","الثلاثاء"])("resolves bare %s without falling out of P3",day=>{
    expect(matches(input("2026-10-20"),"Ava "+day,"2026-10-19")).toBe(true);
    expect(matches(input("2026-10-27","2026-10-26"),"Ava "+day,"2026-10-19")).toBe(false);
  });
  it("respects this/next week and binds weekly caps to explicit dates",()=>{
    expect(matches(input("2026-10-27","2026-10-26"),"Ava next week Tuesday","2026-10-19")).toBe(true);
    expect(matches(input("2026-10-20"),"Ava next week Tuesday","2026-10-19")).toBe(false);
    expect(matches({week:"2026-10-19",overrides:[{}]},"Cap Ava week of 2026-10-20","2026-10-19")).toBe(true);
    expect(matches({week:"2026-10-26",overrides:[{}]},"Cap Ava week of 2026-10-20","2026-10-19")).toBe(false);
  });
});
it("binds forward-looking named dates and rejects impossible explicit dates",()=>{
  expect(matches(input("2026-10-20"),"Ava October 20","2026-10-19")).toBe(true);
  expect(matches(input("2026-10-27","2026-10-26"),"Ava October 20","2026-10-19")).toBe(false);
  expect(matches(input("2026-10-20"),"Ava 2026-02-30","2026-10-19")).toBe(false);
});
