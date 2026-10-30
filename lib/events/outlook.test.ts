import {describe,it,expect} from "vitest";
import {buildEventsOutlook} from "./outlook";
import type {NearbyEvent} from "./nearbyEvents";

const event:NearbyEvent={name:"AI Week",startDate:"2026-11-02",endDate:"2026-11-05",venue:"Convention Center",
  distance:null,kind:"conference",expectedCrowd:"large",sourceUrl:"https://example.org",sourceName:null};

describe("facts-only events outlook",()=>{
  it("lists real calendar entries but never assigns a staffing verdict",async()=>{
    const o=await buildEventsOutlook({today:"2026-10-30",timezone:"America/Chicago",locale:"en",
      readSales:async()=>[],search:async()=>({available:true,events:[event]}),
      readLocation:async()=>({label:"Austin",city:"Austin",region:"TX",countryCode:"US",postalCode:null,source:"profile"})});
    if("tooFarAhead" in o)throw new Error("unexpected");
    const halloween=o.days[1];
    expect(halloween).toMatchObject({date:"2026-10-31",holidays:[{name:"Halloween"}],
      typicalSalesCents:null,lastTime:null,usualHourlySales:[]});
    expect(halloween).not.toHaveProperty("decision");
    expect(halloween).not.toHaveProperty("notable");
    expect(halloween.holidays[0]).not.toHaveProperty("usualEffect");
    expect(halloween.holidays[0]).not.toHaveProperty("why");
    expect(o.days.filter(d=>d.eventIds.includes("e1")).map(d=>d.date))
      .toEqual(["2026-11-02","2026-11-03","2026-11-04","2026-11-05"]);
  });
  it("keeps the holidays when sales history fails without manufacturing a decision",async()=>{
    const o=await buildEventsOutlook({today:"2026-10-30",timezone:"America/Chicago",locale:"en",
      readSales:async()=>{throw new Error("db");}});
    if("tooFarAhead" in o)throw new Error("unexpected");
    expect(o.notCovered).toContain("salesHistoryUnavailable");
    expect(o.days[1].holidays.map(h=>h.key)).toEqual(["halloween"]);
    expect(o.days[1].typicalSalesCents).toBeNull();
  });
  it("keeps hourly sales unknown when the canonical hourly reader fails",async()=>{
    const o=await buildEventsOutlook({today:"2026-10-30",timezone:"America/Chicago",locale:"en",
      readSales:async()=>[],readHourlySales:async()=>null});
    if("tooFarAhead" in o)throw new Error("unexpected");
    expect(o.notCovered).toContain("hourlySalesUnavailable");
    expect(o.days[1].usualHourlySales).toEqual([]);
  });
});
