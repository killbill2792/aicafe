import {describe,expect,it} from "vitest";
import {cafeToday,cafeDayRange,shiftCafeDate} from "./clock";
describe("café-local dates",()=>{
  it("keeps 11 PM UTC-7 in the same café day",()=>{
    const now=new Date("2026-10-29T06:00:00Z");
    expect(cafeToday("America/Los_Angeles",now)).toBe("2026-10-28");
    expect(cafeDayRange("America/Los_Angeles",{preset:"last_28_complete_days",now}))
      .toEqual({from:"2026-09-30",to:"2026-10-27"});
  });
  it("never falls back to UTC or accepts invalid ranges",()=>{
    expect(()=>cafeToday("",new Date())).toThrow();
    expect(()=>cafeToday("Not/AZone",new Date())).toThrow();
    expect(()=>cafeDayRange("UTC",{from:"2026-10-30",to:"2026-10-01"})).toThrow();
    expect(shiftCafeDate("2026-03-01",-1)).toBe("2026-02-28");
  });
});
