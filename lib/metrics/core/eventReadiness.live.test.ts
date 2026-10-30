import {describe,it,expect} from "vitest";
import {indexHourlyRevenue,compareLiveEventSales} from "./eventReadiness";

const dates=["2026-10-09","2026-10-16","2026-10-23"];
const certified=dates.map((date,i)=>({date,netSalesCents:[10000,12000,14000][i]}));
const hours=indexHourlyRevenue(dates.flatMap((date,i)=>[
 {date,hourLocal:8,netSalesCents:[4000,6000,8000][i]},
 {date,hourLocal:9,netSalesCents:6000},
]));

describe("live event comparison uses reconciled canonical hourly history",()=>{
 it("compares only historic same-weekday hours and labels a large change notable",()=>{
   const result=compareLiveEventSales(certified,hours,"2026-10-30",14000,8,new Set());
   expect(result).toEqual({actualCents:14000,typicalCents:6000,
     changePercent:133,baselineDays:3,throughHour:8,notable:true});
 });
 it("will not notify for a small money difference even if percent is large",()=>{
   const result=compareLiveEventSales(certified,hours,"2026-10-30",11000,8,new Set());
   expect(result).toMatchObject({changePercent:83,notable:true});
   const low=compareLiveEventSales(certified,hours,"2026-10-30",10000,8,new Set());
   expect(low).toMatchObject({changePercent:67,notable:false});
 });
 it("does not invent an hourly baseline from missing hours or excluded event days",()=>{
   const excluded=compareLiveEventSales(certified,hours,"2026-10-30",14000,8,
     new Set(["2026-10-16"]));
   expect(excluded).toMatchObject({typicalCents:null,baselineDays:2,
     changePercent:null,notable:false});
   const missing=indexHourlyRevenue([
     {date:dates[0],hourLocal:8,netSalesCents:4000},
     {date:dates[1],hourLocal:8,netSalesCents:6000},
     {date:dates[2],hourLocal:8,netSalesCents:8000},
   ]);
   expect(compareLiveEventSales(certified,missing,"2026-10-30",14000,8,new Set()))
     .toMatchObject({typicalCents:null,notable:false});
 });
 it("does not call an incomplete current hour a sales slump",()=>{
   // The 08:00 historical hour is complete, but the live reading at 08:01 is not.
   expect(compareLiveEventSales(certified,hours,"2026-10-30",0,8,new Set()))
     .toMatchObject({changePercent:-100,notable:false});
   // By 09:01 the full 08:00 hour has passed. Missing that much is notable.
   expect(compareLiveEventSales(certified,hours,"2026-10-30",0,9,new Set()))
     .toMatchObject({changePercent:-100,notable:true});
 });
 it("rejects malformed or unsafe live money and hours",()=>{
   expect(compareLiveEventSales(certified,hours,"2026-10-30",NaN,8,new Set())).toBeNull();
   expect(compareLiveEventSales(certified,hours,"2026-10-30",14000,24,new Set())).toBeNull();
 });
});
