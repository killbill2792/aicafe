import {describe,expect,it} from "vitest";
import {indexHourlyRevenue,hourlyMatchesDaily,compareEventDaySales} from "./eventReadiness";
import {typicalDaySales} from "./dayOutlook";
describe("canonical event hourly money math",()=>{
 it("merges locations and reconciles the exact daily total",()=>{
  const values=indexHourlyRevenue([
   {date:"2026-10-31",hourLocal:9,netSalesCents:1500},
   {date:"2026-10-31",hourLocal:9,netSalesCents:2500},
   {date:"2026-10-31",hourLocal:10,netSalesCents:3000},
  ]);
  expect(values.get("2026-10-31")?.get(9)).toBe(4000);
  expect(hourlyMatchesDaily(values.get("2026-10-31"),7000)).toBe(true);
  expect(hourlyMatchesDaily(values.get("2026-10-31"),7001)).toBe(false);
  expect(hourlyMatchesDaily(undefined,0)).toBe(false);
 });
 it("fails closed on unsafe cents",()=>{
  expect(()=>indexHourlyRevenue([
   {date:"2026-10-31",hourLocal:9,netSalesCents:Number.MAX_SAFE_INTEGER},
   {date:"2026-10-31",hourLocal:9,netSalesCents:1},
  ])).toThrow("Hourly money exceeds safe integer cents");
 });
 it("reuses the exact usual-day sales calculation even when old hours are missing",()=>{
  const target="2026-10-31",days=[
    {date:"2026-09-26",netSalesCents:9000},
    {date:"2026-10-03",netSalesCents:10000},
    {date:"2026-10-10",netSalesCents:20000},
    {date:"2026-10-17",netSalesCents:-500}, // invalid in both paths
    {date:"2026-10-24",netSalesCents:30000}, // daily covered, hourly missing
    {date:target,netSalesCents:24000},
  ];
  const hourly=indexHourlyRevenue([
    {date:"2026-09-26",hourLocal:10,netSalesCents:9000},
    {date:"2026-10-03",hourLocal:10,netSalesCents:10000},
    {date:"2026-10-10",hourLocal:10,netSalesCents:20000},
    {date:target,hourLocal:10,netSalesCents:24000},
  ]);
  const excluded=new Set(["2026-10-10"]);
  const expected=typicalDaySales(days,target,target,{exclude:excluded});
  expect(expected).toMatchObject({typicalCents:10000,sampleDays:3});
  const report=compareEventDaySales(days,hourly,target,excluded);
  expect(report).toMatchObject({actualCents:24000,typicalCents:expected.typicalCents,
    baselineDays:expected.sampleDays,changePercent:140});
  expect(report?.hours[10]).toMatchObject({hourLocal:10,usualCents:null,sampleDays:2});
  expect(report?.hours[9]).toMatchObject({hourLocal:9,actualCents:0,usualCents:null,sampleDays:2});
 });
 it("uses the canonical weekday and eight-week window for every hourly estimate",()=>{
  const target="2026-10-31",weekdays=["2026-09-12","2026-09-19","2026-09-26",
    "2026-10-03","2026-10-10","2026-10-17","2026-10-24"];
  const days=[...weekdays.map(date=>({date,netSalesCents:1000})),
    {date:"2026-10-23",netSalesCents:90000},{date:target,netSalesCents:1500}];
  const hours=indexHourlyRevenue(days.map(day=>({date:day.date,hourLocal:12,
    netSalesCents:day.netSalesCents})));
  const report=compareEventDaySales(days,hours,target,new Set());
  expect(report?.typicalCents).toBe(typicalDaySales(days,target,target).typicalCents);
  expect(report?.hours[12]).toMatchObject({usualCents:1000,sampleDays:7,changePercent:50});
 });
 it("does not claim an actual day from absent or mismatched hourly sources",()=>{
  const target="2026-10-31",days=[{date:target,netSalesCents:24000}];
  expect(compareEventDaySales(days,new Map(),target,new Set())).toBeNull();
  expect(compareEventDaySales(days,indexHourlyRevenue([
    {date:target,hourLocal:10,netSalesCents:23000}]),target,new Set())).toBeNull();
 });

});
