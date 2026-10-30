import {describe,expect,it} from "vitest";
import {indexHourlyRevenue,hourlyMatchesDaily} from "./eventReadiness";
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
});
