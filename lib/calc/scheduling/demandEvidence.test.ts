import {describe,expect,it} from "vitest";
import {comparableDemandHours} from "./demandEvidence";
import type {Hour} from "@/lib/data/posFactReaders.server";

const period={from:"2026-09-21",to:"2026-11-15"};
const row=(date:string,ordersCount:number,netSalesCents:number,locationId:string|null="location-1",hourLocal=9):Hour=>
 ({date,ordersCount,netSalesCents,locationId,hourLocal});
const input=(hours:Hour[],missing:string[]=[],stale:string[]=[])=>({
 targetWeekStart:"2026-11-16",historicalPeriod:period,
 readAt:"2026-11-12T18:00:00Z",hours,missing,stale,
});

describe("Task 13a pure historical demand evidence",()=>{
 it("averages only independently observed matching weekdays/hour/location with exact sample dates",()=>{
  const r=comparableDemandHours(input([
   row("2026-11-02",4,1000),row("2026-11-09",8,2000),
   row("2026-11-02",11,3000,"location-2"),
   row("2026-11-09",5,1000,"location-2"),
   row("2026-11-03",100,15000,"location-1"),
  ]));
  expect(r.status).toBe("available");
  expect(r.hours.filter(h=>h.targetDate==="2026-11-16")).toEqual([
   {targetDate:"2026-11-16",hourLocal:9,locationId:"location-1",
    observedAverageOrders:6,observedAverageNetSalesCents:1500,
    sampleDays:["2026-11-02","2026-11-09"]},
   {targetDate:"2026-11-16",hourLocal:9,locationId:"location-2",
    observedAverageOrders:8,observedAverageNetSalesCents:2000,
    sampleDays:["2026-11-02","2026-11-09"]},
  ]);
  expect(r.source).toBe("hourly_sales_rollup");
  expect(r.basis).toBe("observed_comparable_weekday_close_hours");
  expect(r.sourceUpdatedAt).toBeNull();
  expect(r.hours.every(h=>!("requiredHeadcount" in h))).toBe(true);
 });
 it("never treats a missing day, failed import or stale source as a zero-demand hour",()=>{
  const facts=[row("2026-11-02",0,0),row("2026-11-09",0,0)];
  for(const missing of [["hourlySalesDatesNotObserved"],["toastImportIncompleteDays:1:2026-11-09:0"]]){
   const r=comparableDemandHours(input(facts,missing));
   expect(r.status).toBe("unavailable");
   expect(r.hours).toEqual([]);
   expect(r.missing).toEqual(missing);
  }
  expect(comparableDemandHours(input(facts,[],["sourceStale"])).status).toBe("unavailable");
 });
 it("fails closed on duplicate same-day/source-hour records instead of double counting",()=>{
  const facts=[row("2026-11-02",4,500),row("2026-11-02",4,500),
   row("2026-11-09",8,800)];
  const r=comparableDemandHours(input(facts));
  expect(r.status).toBe("unavailable");
  expect(r.missing).toEqual(["ambiguousDuplicateHourlyFact"]);
  expect(r.hours).toEqual([]);
 });
 it("requires repeated comparable observations and rejects unsafe values",()=>{
  expect(comparableDemandHours(input([row("2026-11-09",0,0)])).missing)
   .toEqual(["insufficientComparableHourSamples"]);
  expect(comparableDemandHours(input([])).missing).toEqual(["noHourlySalesFacts"]);
  expect(comparableDemandHours(input([row("2026-11-02",-1,200),
   row("2026-11-09",2,100)])).missing).toEqual(["unsafeHourlySalesFacts"]);
  expect(comparableDemandHours(input([row("2026-11-02",4,200,"other",25),
   row("2026-11-09",2,100)])).status).toBe("unavailable");
 });
 it("does not assign unlinked location facts to a known café location",()=>{
  const r=comparableDemandHours(input([row("2026-11-02",4,200,null),
   row("2026-11-09",2,100,null)]));
  expect(r.status).toBe("available");
  expect(r.hours).toEqual([{
   targetDate:"2026-11-16",hourLocal:9,locationId:null,
   observedAverageOrders:3,observedAverageNetSalesCents:150,
   sampleDays:["2026-11-02","2026-11-09"],
  }]);
 });

 it("caps model-bound rows without silently claiming the subset is all observed history",()=>{
  const facts=Array.from({length:90},(_,i)=>[
    row("2026-11-02",i,1000,"location-"+i),
    row("2026-11-09",i+2,1200,"location-"+i),
  ]).flat();
  const result=comparableDemandHours(input(facts));
  expect(result.status).toBe("available");
  expect(result.totalComparableHours).toBe(90);
  expect(result.truncated).toBe(true);
  expect(result.hours).toHaveLength(80);
  expect(result.missing).toContain("comparableHourResultTruncated");
 });
});
