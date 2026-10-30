import {describe,expect,it} from "vitest";
import {timecardWagesForLocalDay} from "./timecardDay";
import {providerShiftPayCents,wagesCentsForTimecard,OVERTIME_PAY_MULTIPLIER} from "@/lib/calc/staff";

const tz="America/Los_Angeles";
describe("Toast shift pay uses Toast's own hours",()=>{
 it("pays regular hours at the wage and overtime at 1.5x",()=>{
  expect(OVERTIME_PAY_MULTIPLIER).toBe(1.5);
  // 8 regular + 2 overtime at $20/h = 160 + 60 = $220
  expect(providerShiftPayCents({clockOut:"2026-10-10T20:00:00Z",hourlyWageCents:2000,
   providerRegularHours:8,providerOvertimeHours:2})).toBe(22000);
 });
 it("uses Toast's hours even when the clock times say otherwise",()=>{
  const tc={clockIn:"2026-10-10T16:00:00Z",clockOut:"2026-10-11T04:00:00Z",hourlyWageCents:2000,
   breaks:[],providerRegularHours:8,providerOvertimeHours:2};
  // Clock time is 12h (=$240) but Toast says 8 + 2 OT.
  expect(wagesCentsForTimecard(tc)).toBe(22000);
 });
 it("a $0 Toast wage gives $0, not unknown",()=>{
  const tc={clockIn:"2026-10-12T21:56:52Z",clockOut:"2026-10-13T03:23:59Z",hourlyWageCents:0,
   breaks:[],providerRegularHours:5.45,providerOvertimeHours:0};
  expect(wagesCentsForTimecard(tc)).toBe(0);
  expect(timecardWagesForLocalDay(tc,"2026-10-12",tz)).toBe(0);
 });
 it("splits Toast pay across midnight by paid time, and the days add up to the shift",()=>{
  // 6pm to 2am LA time: 6h on day 1, 2h on day 2; Toast says 6 regular + 2 overtime.
  const shift={clockIn:"2026-10-11T01:00:00Z",clockOut:"2026-10-11T09:00:00Z",hourlyWageCents:2000,
   providerRegularHours:6,providerOvertimeHours:2};
  const total=6*2000+2*2000*1.5;
  const d1=timecardWagesForLocalDay(shift,"2026-10-10",tz)!;
  const d2=timecardWagesForLocalDay(shift,"2026-10-11",tz)!;
  expect(d1).toBeCloseTo(total*6/8,6);
  expect(d2).toBeCloseTo(total*2/8,6);
  expect(d1+d2).toBeCloseTo(total,6);
 });
 it("shifts without Toast hours keep the clock-time calculation",()=>{
  const shift={clockIn:"2026-10-10T16:00:00Z",clockOut:"2026-10-10T20:00:00Z",hourlyWageCents:1500};
  expect(timecardWagesForLocalDay(shift,"2026-10-10",tz)).toBe(6000);
 });
});
