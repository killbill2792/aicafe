import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const jobs=vi.hoisted(()=>({
  shifts:vi.fn(async()=>undefined),alerts:vi.fn(async()=>({created:2})),prices:vi.fn(async()=>undefined),anomalies:vi.fn(async()=>3),
}));
vi.mock("@/lib/data/materializeSchedule",()=>({
  ensureScheduledShiftsThroughDate:jobs.shifts,
}));
vi.mock("./generate",()=>({generateAlerts:jobs.alerts}));
vi.mock("@/lib/data/operatingTasks",()=>({refreshPriceReviewTasks:jobs.prices}));
vi.mock("./businessAnomalies.server",()=>({refreshBusinessAnomalies:jobs.anomalies}));
import {refreshDerivedForBusiness} from "./refreshDerived.server";
beforeEach(()=>{jobs.shifts.mockClear();jobs.alerts.mockClear();jobs.prices.mockClear();jobs.anomalies.mockClear()});
describe("refreshDerived",()=>{
  it("runs schedules before alerts with business local date, repeatable and not on page load",async()=>{
    const db={} as Parameters<typeof refreshDerivedForBusiness>[0];
    const date=new Date("2026-10-29T05:30:00Z"); // LA: Oct 28
    const a=await refreshDerivedForBusiness(db,"cafe-one","America/Los_Angeles",date);
    const b=await refreshDerivedForBusiness(db,"cafe-one","America/Los_Angeles",date);
    expect(a).toEqual({businessDate:"2026-10-28",alertsCreated:5});
    expect(b).toEqual(a);
    expect(jobs.shifts).toHaveBeenCalledTimes(2);
    expect(jobs.shifts).toHaveBeenNthCalledWith(1,db,"cafe-one",
      "America/Los_Angeles","2026-10-28");
    expect(jobs.alerts).toHaveBeenCalledTimes(2);
    expect(jobs.prices).toHaveBeenCalledTimes(2);
    expect(jobs.prices).toHaveBeenCalledWith(db,"cafe-one",date);
    expect(jobs.anomalies).toHaveBeenCalledWith(db,"cafe-one","2026-10-28","America/Los_Angeles",date);
    expect(jobs.shifts.mock.invocationCallOrder[0]).toBeLessThan(jobs.alerts.mock.invocationCallOrder[0]);
  });
  it("refuses an absent timezone rather than creating UTC-based data",async()=>{
    await expect(refreshDerivedForBusiness({} as never,"cafe-one",""))
      .rejects.toThrow("Missing café refresh scope");
    expect(jobs.shifts).not.toHaveBeenCalled();
  });
});
