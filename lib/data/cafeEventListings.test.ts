import {describe,it,expect} from "vitest";
import {cafeEventInArea,visibleCafeEventListings,type CafeEvent} from "./cafeEvents.server";
const location={city:"San Jose",region:"CA"};
const event=(id:string,name:string,date:string,verified=false):CafeEvent=>({
  id,name,kind:"other",startDate:date,endDate:date,startTime:null,endTime:null,
  venue:null,venueAddress:null,areaLabel:null,sourceUrl:"https://example.org/"+id,
  status:"found",foundAt:"2026-11-03T00:00:00Z",lastCheckedAt:"2026-11-03T00:00:00Z",
  lastVerifiedAt:verified?"2026-11-03T14:00:00Z":null,
});
describe("one canonical café-event list projection",()=>{
  it("deduplicates normalized market names and filters far saved geography, not names",()=>{
    const items=[
      event("a","Bhangra & Beats Night Market","2026-11-13"),
      {...event("b","Bhangra and Beats Night Market","2026-11-13",true),venueAddress:"100 Main St, San Jose, CA"},
      {...event("c","Regional Music Night","2026-11-13"),venueAddress:"1 Park Way, Mill Valley, CA",areaLabel:"95 miles"},
      {...event("d","Community Market","2026-11-14"),venueAddress:"20 Main St, San Jose, CA",areaLabel:"3 miles"},
    ];
    expect(visibleCafeEventListings(items,"2026-11-03","2026-11-16",location).map(e=>e.id))
      .toEqual(["b","d"]);
    // Saved facts and identities are not modified.
    expect(items.map(e=>e.id)).toEqual(["a","b","c","d"]);
  });
  it("uses stated distance across nearby-city boundaries and retains unknown geography",()=>{
    expect(cafeEventInArea({...event("a","Near","2026-11-13"),
      venueAddress:"10 Main St, Mountain View, CA",areaLabel:"12 mi"},location)).toBe(true);
    expect(cafeEventInArea({...event("b","Far","2026-11-13"),
      venueAddress:"10 Main St, Far City, CA",areaLabel:"105 km"},location)).toBe(false);
    expect(cafeEventInArea({...event("c","Far","2026-11-13"),
      venueAddress:"10 Main St, Other City, CA"},location)).toBe(false);
    expect(visibleCafeEventListings([event("d","Unknown","2026-11-13")],
      "2026-11-03","2026-11-16",location)).toHaveLength(1);
    expect(cafeEventInArea({venueAddress:"10 Main St, Other City, CA",areaLabel:null},null)).toBe(true);
  });
});
