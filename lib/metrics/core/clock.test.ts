import {describe,expect,it} from "vitest";
import {cafeToday,shiftCafeDate} from "./clock";
describe("café-local dates",()=>{
  it("keeps 11 PM UTC-7 in the same café day",()=>{
    const now=new Date("2026-10-29T06:00:00Z");
    expect(cafeToday("America/Los_Angeles",now)).toBe("2026-10-28");
  });
  it("never falls back to UTC or accepts invalid ranges",()=>{
    expect(()=>cafeToday("",new Date())).toThrow();
    expect(()=>cafeToday("Not/AZone",new Date())).toThrow();
    expect(shiftCafeDate("2026-03-01",-1)).toBe("2026-02-28");
  });
});
