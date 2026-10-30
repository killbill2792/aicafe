import {describe,it,expect} from "vitest";
import {eventScanWindows,eventIdentity,savedEventKind} from "./eventsLookahead";

const state=(scannedThroughDate:string,weeklyResearchedOn:string|null=null)=>({
  locationHash:"location-a",scannedThroughDate,weeklyResearchedOn,
});
describe("scheduled event discovery",()=>{
 it("first search covers fourteen days on every weekday, including Monday",()=>{
   expect(eventScanWindows("2026-11-03",null,"location-a")).toEqual([
     {from:"2026-11-03",to:"2026-11-16",reason:"initial"},
   ]);
   expect(eventScanWindows("2026-11-02",null,"location-a")).toEqual([
     {from:"2026-11-02",to:"2026-11-15",reason:"initial"},
   ]);
 });
 it("daily search adds exactly one new day and avoids repeat work",()=>{
   expect(eventScanWindows("2026-11-04",state("2026-11-16"),"location-a")).toEqual([
     {from:"2026-11-17",to:"2026-11-17",reason:"new_day"},
   ]);
   expect(eventScanWindows("2026-11-04",state("2026-11-17"),"location-a")).toEqual([]);
 });
 it("Monday researches the full window once for late announcements",()=>{
   expect(eventScanWindows("2026-11-09",state("2026-11-21"),"location-a")).toEqual([
     {from:"2026-11-09",to:"2026-11-22",reason:"weekly"},
   ]);
   expect(eventScanWindows("2026-11-09",state("2026-11-22","2026-11-09"),"location-a"))
     .toEqual([]);
   expect(eventScanWindows("2026-11-10",state("2026-11-22","2026-11-09"),"location-a"))
     .toEqual([{from:"2026-11-23",to:"2026-11-23",reason:"new_day"}]);
 });
 it("an address change requires a new full look-ahead",()=>{
   expect(eventScanWindows("2026-11-05",state("2026-11-18"),"location-b")).toEqual([
     {from:"2026-11-05",to:"2026-11-18",reason:"initial"},
   ]);
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
