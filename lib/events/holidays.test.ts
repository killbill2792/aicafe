import {describe,it,expect} from "vitest";
import {holidaysBetween,holidayDateInYear,cafeCountry,weekdayOf,addDays,daysBetween} from "./holidays";

const find=(key:string,year:number,country="US",region:string|null=null)=>
  holidaysBetween(year+"-01-01",year+"-12-31",country,region).find(h=>h.key===key);

describe("holidays from the maintained date-holidays data",()=>{
  it("puts Halloween 2026 on Saturday October 31 — tomorrow when today is Oct 30",()=>{
    const week=holidaysBetween("2026-10-30","2026-11-05","US");
    expect(week.map(h=>[h.key,h.date,h.kind])).toEqual([["halloween","2026-10-31","observance"]]);
    expect(weekdayOf("2026-10-31")).toBe(6);
    expect(week[0].usualEffect).toBe("busier");
    expect(week[0].why).toMatch(/trick-or-treat/iu);
    expect(week[0].dayOff).toBe(false);
  });
  it("works out moving US holidays every year (no fixed dates in our code)",()=>{
    expect(find("labor_day",2026)?.date).toBe("2026-09-07");
    expect(find("labor_day",2027)?.date).toBe("2027-09-06");
    expect(find("thanksgiving_day",2026)?.date).toBe("2026-11-26");
    expect(find("mother_s_day",2026)?.date).toBe("2026-05-10");
    expect(find("easter_sunday",2027)?.date).toBe("2027-03-28");
    expect(find("labor_day",2026)).toMatchObject({kind:"public_holiday",dayOff:true,name:"Labor Day"});
  });
  it("marks the weekday off when a holiday falls on a weekend",()=>{
    expect(find("independence_day_observed",2026)?.date).toBe("2026-07-03");
    expect(holidayDateInYear("independence_day_observed",2026,"US")).toBe("2026-07-03");
  });
  it("follows holidays that move with the moon (UAE Eid al-Fitr)",()=>{
    const eid=(y:number)=>holidaysBetween(y+"-01-01",y+"-12-31","AE",null,"ar").find(h=>h.key==="end_of_ramadan_eid_al_fitr");
    expect(eid(2026)?.date).toBe("2026-03-20");
    expect(eid(2027)?.date).toBe("2027-03-09");
    expect(eid(2026)?.name).toBe("عيد الفطر");
  });
  it("uses the café's country and the owner's language",()=>{
    expect(holidaysBetween("2026-10-01","2026-10-31","ES",null,"es").map(h=>[h.date,h.name]))
      .toEqual([["2026-10-12","Fiesta Nacional de España"]]);
    expect(holidaysBetween("2026-11-11","2026-11-11","US",null,"es")[0].name).toBe("Día del Veterano");
  });
  it("adds state holidays and survives an unknown region",()=>{
    expect(holidaysBetween("2026-11-27","2026-11-27","US","TX").map(h=>h.kind)).toEqual(["public_holiday"]);
    expect(holidaysBetween("2026-11-26","2026-11-26","US","Nowhere").map(h=>h.key)).toEqual(["thanksgiving_day"]);
  });
  it("looks up the same holiday last year",()=>{
    expect(holidayDateInYear("halloween",2025,"US")).toBe("2025-10-31");
    expect(holidayDateInYear("labor_day",2025,"US")).toBe("2025-09-01");
    expect(holidayDateInYear("nope",2025,"US")).toBeNull();
    expect(holidayDateInYear("halloween",2025,null)).toBeNull();
  });
  it("never shows holidays for an unknown country",()=>{
    expect(holidaysBetween("2026-10-01","2026-12-31",null)).toEqual([]);
    expect(holidaysBetween("2026-10-01","2026-12-31","ZZ")).toEqual([]);
  });
});

describe("café country and dates",()=>{
  it("prefers the saved profile country, then a US-only timezone",()=>{
    expect(cafeCountry("es","America/New_York")).toEqual({country:"ES",source:"profile"});
    expect(cafeCountry(null,"America/Chicago")).toEqual({country:"US",source:"timezone"});
    expect(cafeCountry(null,"America/Toronto")).toEqual({country:null,source:null});
  });
  it("adds and counts days across month ends",()=>{
    expect(addDays("2026-10-30",2)).toBe("2026-11-01");
    expect(daysBetween("2026-10-30","2026-11-02")).toBe(3);
  });
});
