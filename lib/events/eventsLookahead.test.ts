import {describe,it,expect} from "vitest";
import {eventScanWindows,eventIdentity,savedEventKind} from "./eventsLookahead";

describe("scheduled event discovery",()=>{
 it("refreshes two weeks on Monday and rechecks the day before",()=>{
   expect(eventScanWindows("2026-11-02")).toEqual([
     {from:"2026-11-02",to:"2026-11-08",reason:"weekly"},
     {from:"2026-11-09",to:"2026-11-15",reason:"weekly"},
     {from:"2026-11-03",to:"2026-11-03",reason:"day_before"},
   ]);
 });
 it("on other days searches only the new far boundary and tomorrow",()=>{
   expect(eventScanWindows("2026-11-03")).toEqual([
     {from:"2026-11-16",to:"2026-11-16",reason:"new_day"},
     {from:"2026-11-04",to:"2026-11-04",reason:"day_before"},
   ]);
   expect(eventScanWindows("2026-11-08")[0]).toEqual({
     from:"2026-11-21",to:"2026-11-21",reason:"new_day",
   });
 });
 it("stabilizes event IDs without inventing new database kinds",()=>{
   const event={name:" Farmers Market ",startDate:"2026-11-03",
     sourceUrl:"https://city.example/markets",kind:"market" as const};
   expect(eventIdentity(event)).toBe("other|farmers market|2026-11-03|https://city.example/markets");
   expect(eventIdentity({...event,name:"farmers market"})).toBe(eventIdentity(event));
   expect(savedEventKind("conference")).toBe("conference");
   expect(savedEventKind("road_closure")).toBe("other");
 });
});
