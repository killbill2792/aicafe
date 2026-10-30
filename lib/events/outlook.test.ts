import {describe,it,expect} from "vitest";
import {decideDay,buildEventsOutlook} from "./outlook";
import type {NearbyEvent} from "./nearbyEvents";

const halloween={key:"halloween",name:"Halloween",kind:"observance" as const,dayOff:false,usualEffect:"busier" as const,why:"…"};
const thanksgiving={...halloween,key:"thanksgiving_day",name:"Thanksgiving Day",kind:"public_holiday" as const,dayOff:true,usualEffect:"quieter" as const};
const plainPublic={...halloween,key:"x",name:"Some Day",kind:"public_holiday" as const,dayOff:true,usualEffect:"varies" as const};
const last=(changePercent:number)=>({date:"2025-10-31",netSalesCents:1,typicalCents:1,changePercent,sampleDays:4,holiday:"Halloween"});
const event=(over:Partial<NearbyEvent>={}):NearbyEvent=>({name:"AI Week",startDate:"2026-11-02",endDate:"2026-11-05",venue:null,
  distance:null,kind:"conference",expectedCrowd:"large",sourceUrl:"https://e.org",sourceName:null,...over});

describe("one plain decision per day",()=>{
  it("trusts the café's own sales first",()=>{
    expect(decideDay({lastTime:last(32),holidays:[thanksgiving]},[])).toEqual({expect:"busier",action:"add_staff",basis:"your_sales"});
    expect(decideDay({lastTime:last(-25),holidays:[halloween]},[event()])).toEqual({expect:"quieter",action:"keep_staff_light",basis:"your_sales"});
    expect(decideDay({lastTime:last(4),holidays:[halloween]},[])).toEqual({expect:"normal",action:"normal_staff",basis:"your_sales"});
  });
  it("then a sizeable event nearby",()=>{
    expect(decideDay({lastTime:null,holidays:[]},[event()])).toEqual({expect:"busier",action:"add_staff",basis:"nearby_event"});
    expect(decideDay({lastTime:null,holidays:[]},[event({expectedCrowd:"unknown"})])).toEqual({expect:"unsure",action:"have_backup",basis:"nearby_event"});
    expect(decideDay({lastTime:null,holidays:[]},[event({kind:"road_closure"})]).action).toBe("have_backup");
  });
  it("then the general pattern for the holiday, never pretending it is their data",()=>{
    expect(decideDay({lastTime:null,holidays:[halloween]},[])).toEqual({expect:"busier",action:"add_staff",basis:"general_pattern"});
    expect(decideDay({lastTime:null,holidays:[thanksgiving]},[])).toEqual({expect:"quieter",action:"keep_staff_light",basis:"general_pattern"});
    expect(decideDay({lastTime:null,holidays:[plainPublic]},[])).toEqual({expect:"unsure",action:"have_backup",basis:"general_pattern"});
    expect(decideDay({lastTime:null,holidays:[]},[])).toEqual({expect:"normal",action:"normal_staff",basis:"none"});
  });
});

describe("outlook",()=>{
  it("shows only notable days on the board and a normal week as nothing special",async()=>{
    const o=await buildEventsOutlook({today:"2026-11-02",timezone:"America/Chicago",locale:"en",readSales:async()=>[]});
    if("tooFarAhead" in o)throw new Error("unexpected");
    expect(o.days).toHaveLength(7);
    expect(o.days.filter(d=>d.notable)).toEqual([]);
    expect(o.addressMissing).toBe(true);
  });
  it("keeps going when the sales read fails",async()=>{
    const o=await buildEventsOutlook({today:"2026-10-30",timezone:"America/Chicago",locale:"en",readSales:async()=>{throw new Error("db");}});
    if("tooFarAhead" in o)throw new Error("unexpected");
    expect(o.notCovered).toContain("salesHistoryUnavailable");
    expect(o.days[1]).toMatchObject({date:"2026-10-31",notable:true,decision:{expect:"busier",basis:"general_pattern"}});
  });
});
