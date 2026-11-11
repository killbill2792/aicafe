import {describe,it,expect} from "vitest";
import {eventScanWindows,cityScanWindows,eventIdentity,savedEventKind,dailyCafeScanOrder,closedEventObservationDays} from "./eventsLookahead";

const state=(scannedThroughDate:string,weeklyResearchedOn:string|null=null)=>({
  locationHash:"location-a",scannedThroughDate,weeklyResearchedOn,
});
describe("scheduled event discovery",()=>{
 it("reconciles only closed local dates across daylight-saving transitions",()=>{
   // Spring and autumn changes have 23/25 elapsed hours but one café date.
   expect(closedEventObservationDays("2026-03-07",3,"2026-03-10")).toEqual([
     "2026-03-07","2026-03-08","2026-03-09",
   ]);
   expect(closedEventObservationDays("2026-10-31",3,"2026-11-02")).toEqual([
     "2026-10-31","2026-11-01",
   ]);
   expect(closedEventObservationDays("2026-11-03",1,"2026-11-03")).toEqual([]);
   expect(closedEventObservationDays("2026-10-01",14,"2026-10-20")).toEqual([
     "2026-10-06","2026-10-07","2026-10-08","2026-10-09","2026-10-10",
     "2026-10-11","2026-10-12","2026-10-13","2026-10-14",
   ]);
 });

 it("rotates the shared six-task budget fairly across cafés and pages",()=>{
   const cafes=Array.from({length:205},(_,i)=>({id:"cafe-"+i}));
   const firsts=new Set<string>();
   for(let delta=0;delta<cafes.length;delta++){
     const now=new Date(Date.UTC(2026,10,3+delta));
     const order=dailyCafeScanOrder(cafes,now);
     expect(order).toHaveLength(205);
     expect(new Set(order.map(c=>c.id)).size).toBe(205);
     firsts.add(order[0].id);
     // No café is dropped even if it lived outside the first page.
     expect(order.some(c=>c.id==="cafe-204")).toBe(true);
   }
   expect(firsts.size).toBe(205);
   expect(dailyCafeScanOrder([],new Date("2026-11-03T00:00:00Z"))).toEqual([]);
 });
 it("first search covers fourteen days on every weekday, including Monday",()=>{
   expect(eventScanWindows("2026-11-03",null,"location-a")).toEqual([
     {from:"2026-11-03",to:"2026-11-16",reason:"initial"},
   ]);
   expect(eventScanWindows("2026-11-02",null,"location-a")).toEqual([
     {from:"2026-11-02",to:"2026-11-15",reason:"initial"},
   ]);
 });
 it("an old nearby search marker cannot suppress a missing city research window",()=>{
   expect(cityScanWindows("2026-11-03",state("2026-11-16"),"location-a","unsearched"))
     .toEqual([{from:"2026-11-03",to:"2026-11-16",reason:"initial"}]);
   expect(cityScanWindows("2026-11-03",state("2026-11-16"),"location-a","complete"))
     .toEqual([]);
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
