import {describe,it,expect} from "vitest";
import {holidaysBetween,holidayDateInYear,cafeCountry,weekdayOf,addDays} from "./holidays";

const dateOf=(key:string,year:number)=>holidaysBetween(year+"-01-01",year+"-12-31","US").find(h=>h.key===key)?.date;

describe("US holiday calendar",()=>{
  it("puts Halloween 2026 on Saturday October 31 — tomorrow when today is Oct 30",()=>{
    const week=holidaysBetween("2026-10-30","2026-11-05","US");
    expect(week.map(h=>[h.key,h.date])).toEqual([["halloween","2026-10-31"]]);
    expect(weekdayOf("2026-10-31")).toBe(6);
    expect(week[0].kind).toBe("observance");
    expect(week[0].why).toMatch(/trick-or-treat/iu);
  });
  it("finds the moving holidays on the right dates",()=>{
    expect(dateOf("labor_day",2026)).toBe("2026-09-07");
    expect(dateOf("labor_day",2025)).toBe("2025-09-01");
    expect(dateOf("memorial_day",2026)).toBe("2026-05-25");
    expect(dateOf("thanksgiving",2026)).toBe("2026-11-26");
    expect(dateOf("black_friday",2026)).toBe("2026-11-27");
    expect(dateOf("mothers_day",2026)).toBe("2026-05-10");
    expect(dateOf("fathers_day",2026)).toBe("2026-06-21");
    expect(dateOf("mlk_day",2027)).toBe("2027-01-18");
    expect(dateOf("presidents_day",2027)).toBe("2027-02-15");
    expect(dateOf("indigenous_peoples_day",2026)).toBe("2026-10-12");
    expect(dateOf("easter",2026)).toBe("2026-04-05");
    expect(dateOf("easter",2027)).toBe("2027-03-28");
  });
  it("adds the weekday off when a fixed holiday falls on a weekend",()=>{
    // July 4 2026 is a Saturday: offices close Friday July 3.
    expect(dateOf("independence_day_observed",2026)).toBe("2026-07-03");
    // Veterans Day 2029 is a Sunday: observed Monday Nov 12.
    expect(dateOf("veterans_day_observed",2029)).toBe("2029-11-12");
    expect(dateOf("veterans_day_observed",2026)).toBeUndefined();
  });
  it("looks up the same holiday last year for comparison",()=>{
    expect(holidayDateInYear("halloween",2025)).toBe("2025-10-31");
    expect(holidayDateInYear("labor_day",2025)).toBe("2025-09-01");
    expect(holidayDateInYear("independence_day_observed",2026)).toBe("2026-07-03");
    expect(holidayDateInYear("not_a_holiday",2025)).toBeNull();
  });
  it("never shows US holidays for another or unknown country",()=>{
    expect(holidaysBetween("2026-10-01","2026-12-31","ES")).toEqual([]);
    expect(holidaysBetween("2026-10-01","2026-12-31",null)).toEqual([]);
  });
  it("spans a new year",()=>{
    expect(holidaysBetween("2026-12-30","2027-01-02","US").map(h=>h.key))
      .toEqual(["new_years_eve","new_years_day"]);
  });
});

describe("café country",()=>{
  it("prefers the saved profile country, then a US-only timezone",()=>{
    expect(cafeCountry("es","America/New_York")).toEqual({country:"ES",source:"profile"});
    expect(cafeCountry(null,"America/Chicago")).toEqual({country:"US",source:"timezone"});
    expect(cafeCountry("","America/Indiana/Indianapolis")).toEqual({country:"US",source:"timezone"});
    // Shared or non-US zones are never guessed.
    expect(cafeCountry(null,"America/Toronto")).toEqual({country:null,source:null});
    expect(cafeCountry(null,"Asia/Dubai")).toEqual({country:null,source:null});
  });
  it("adds days across month ends",()=>{
    expect(addDays("2026-10-30",2)).toBe("2026-11-01");
    expect(addDays("2026-03-01",-1)).toBe("2026-02-28");
  });
});
