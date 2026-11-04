import {describe,it,expect} from "vitest";
import {visibleCafeEventListings,type CafeEvent} from "./cafeEvents.server";
const event=(id:string,name:string,date:string,venue:string|null=null,verified=false):CafeEvent=>({
  id,name,kind:"other",startDate:date,endDate:date,startTime:null,endTime:null,
  venue,venueAddress:null,areaLabel:null,sourceUrl:"https://example.org/"+id,
  status:"found",foundAt:"2026-11-03T00:00:00Z",lastCheckedAt:"2026-11-03T00:00:00Z",
  lastVerifiedAt:verified?"2026-11-03T14:00:00Z":null,
});
describe("one canonical café-event list projection",()=>{
  it("keeps one verified Bhangra night market and drops documented far-away parks",()=>{
    const items=[
      event("a","Bhangra & Beats Night Market","2026-11-13"),
      event("b","Bhangra and Beats Night Market","2026-11-13",null,true),
      event("c","National Parks Day at Muir Woods","2026-11-13","Muir Woods"),
      event("d","Yosemite National Parks Day","2026-11-13","Yosemite"),
      event("e","Community Market","2026-11-14","San Jose"),
    ];
    const visible=visibleCafeEventListings(items,"2026-11-03","2026-11-16","San Jose");
    expect(visible.map(e=>e.id)).toEqual(["b","e"]);
    expect(items.map(e=>e.id)).toEqual(["a","b","c","d","e"]);
  });
  it("does not assume distance when no café city has been saved",()=>{
    const items=[event("a","Muir Woods talk","2026-11-13")];
    expect(visibleCafeEventListings(items,"2026-11-03","2026-11-16",null)).toEqual(items);
  });
});
