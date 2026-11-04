import {describe,it,expect} from "vitest";
import {cafeEventInArea,visibleCafeEventListings,cafeEventDistanceKm,
  CAFE_EVENT_RADIUS_KM,type CafeEvent} from "./cafeEvents.server";
const location={city:"San Francisco",region:"CA",latitude:37.7749,longitude:-122.4194};
const event=(id:string,name:string,date:string,verified=false):CafeEvent=>({
  id,name,kind:"other",startDate:date,endDate:date,startTime:null,endTime:null,
  venue:null,venueAddress:null,areaLabel:null,sourceUrl:"https://example.org/"+id,
  status:"found",foundAt:"2026-11-03T00:00:00Z",lastCheckedAt:"2026-11-03T00:00:00Z",
  lastVerifiedAt:verified?"2026-11-03T14:00:00Z":null,
});
describe("one canonical café-event list projection",()=>{
  it("keeps the verified normalized market and a nearby Oakland event; drops distant Los Angeles",()=>{
    const items=[
      event("a","Bhangra & Beats Night Market","2026-11-13"),
      {...event("b","Bhangra and Beats Night Market","2026-11-13",true),
        venueAddress:"100 Main St, San Francisco, CA"},
      {...event("c","Regional Music Night","2026-11-13"),
        venueAddress:"1 Park Way, Los Angeles, CA",latitude:34.0522,longitude:-118.2437},
      {...event("d","Community Market","2026-11-14"),
        venueAddress:"20 Main St, Oakland, CA",latitude:37.8044,longitude:-122.2712},
    ];
    expect(visibleCafeEventListings(items,"2026-11-03","2026-11-16",location).map(e=>e.id))
      .toEqual(["b","d"]);
    expect(items.map(e=>e.id)).toEqual(["a","b","c","d"]);
  });
  it("uses a 50 km radius when both points exist, including neighbouring cities",()=>{
    const oakland={venueAddress:"10 Main St, Oakland, CA",areaLabel:null,
      latitude:37.8044,longitude:-122.2712};
    const far={venueAddress:"10 Main St, Los Angeles, CA",areaLabel:null,
      latitude:34.0522,longitude:-118.2437};
    expect(cafeEventDistanceKm(location,oakland)).toBeLessThan(CAFE_EVENT_RADIUS_KM);
    expect(cafeEventInArea(oakland,location)).toBe(true);
    expect(cafeEventDistanceKm(location,far)).toBeGreaterThan(CAFE_EVENT_RADIUS_KM);
    expect(cafeEventInArea(far,location)).toBe(false);
  });
  it("without coordinates, excludes only clearly different regions, not different cities",()=>{
    expect(cafeEventInArea({venueAddress:"20 Main St, Oakland, CA",areaLabel:null},
      {city:"San Francisco",region:"CA"})).toBe(true);
    expect(cafeEventInArea({venueAddress:"1 East Ave, Portland, OR",areaLabel:null},
      {city:"San Francisco",region:"CA"})).toBe(false);
    expect(cafeEventInArea({venueAddress:"1 East Ave, Portland, OR",areaLabel:null},
      null)).toBe(true);
    expect(cafeEventInArea({venueAddress:null,areaLabel:null},location)).toBe(true);
    // A region name and an abbreviation are not treated as different states.
    expect(cafeEventInArea({venueAddress:"5 Main St, Oakland, CA",areaLabel:null},
      {city:"San Francisco",region:"California"})).toBe(true);
  });
});