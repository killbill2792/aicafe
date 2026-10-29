import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const jobs=vi.hoisted(()=>({
  shifts:vi.fn(async()=>undefined),alerts:vi.fn(async()=>({created:2})),
}));
vi.mock("@/lib/data/materializeSchedule",()=>({
  ensureScheduledShiftsThroughDate:jobs.shifts,
}));
vi.mock("./generate",()=>({generateAlerts:jobs.alerts}));
import {refreshDerivedForBusiness} from "./refreshDerived.server";
beforeEach(()=>{jobs.shifts.mockClear();jobs.alerts.mockClear()});
describe("refreshDerived",()=>{
  it("runs schedules before alerts with business local date, repeatable and not on page load",async()=>{
    const db={} as Parameters<typeof refreshDerivedForBusiness>[0];
    const date=new Date("2026-10-29T05:30:00Z"); // LA: Oct 28
    const a=await refreshDerivedForBusiness(db,"cafe-one","America/Los_Angeles",date);
    const b=await refreshDerivedForBusiness(db,"cafe-one","America/Los_Angeles",date);
    expect(a).toEqual({businessDate:"2026-10-28",alertsCreated:2});
    expect(b).toEqual(a);
    expect(jobs.shifts).toHaveBeenCalledTimes(2);
    expect(jobs.shifts).toHaveBeenNthCalledWith(1,db,"cafe-one",
      "America/Los_Angeles","2026-10-28");
    expect(jobs.alerts).toHaveBeenCalledTimes(2);
    expect(jobs.shifts.mock.invocationCallOrder[0]).toBeLessThan(jobs.alerts.mock.invocationCallOrder[0]);
  });
  it("refuses an absent timezone rather than creating UTC-based data",async()=>{
    await expect(refreshDerivedForBusiness({} as never,"cafe-one",""))
      .rejects.toThrow("Missing café refresh scope");
    expect(jobs.shifts).not.toHaveBeenCalled();
  });
});
