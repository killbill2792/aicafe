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
    const db={rpc:vi.fn(async()=>({data:null,error:{code:"PGRST202"}}))} as unknown as Parameters<typeof refreshDerivedForBusiness>[0];
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

describe("U1 shared durable refresh admission",()=>{
  const date=new Date("2026-11-20T17:00:00Z");
  it("queues post-import work without reads or leaked identifiers",async()=>{
    const rpc=vi.fn(async()=>({data:null,error:null}));
    const db={rpc} as unknown as Parameters<typeof refreshDerivedForBusiness>[0];
    expect(await refreshDerivedForBusiness(db,"cafe-one","UTC",date,{enqueueOnly:true})).toEqual({
      businessDate:"2026-11-20",alertsCreated:0,deferred:true,
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("supervisor_claim_derived_refresh",{p_business_id:"cafe-one",p_admit:false});
    expect(jobs.shifts).not.toHaveBeenCalled();
  });
  it("settles only its acquired token and retains arrivals during execution",async()=>{
    const rpc=vi.fn(async(name:string)=>name==="supervisor_claim_derived_refresh"?
      {data:{token:"lease-a"},error:null}:{data:{accepted:true,pending:true},error:null});
    const db={rpc} as unknown as Parameters<typeof refreshDerivedForBusiness>[0];
    expect(await refreshDerivedForBusiness(db,"cafe-one","UTC",date)).toEqual({
      businessDate:"2026-11-20",alertsCreated:5,deferred:true,
    });
    expect(rpc.mock.calls.map(([name])=>name)).toEqual(["supervisor_claim_derived_refresh","supervisor_finish_derived_refresh"]);
    expect(rpc).toHaveBeenLastCalledWith("supervisor_finish_derived_refresh",{p_business_id:"cafe-one",p_token:"lease-a",p_success:true});
    expect(jobs.alerts.mock.invocationCallOrder[0]).toBeLessThan(jobs.prices.mock.invocationCallOrder[0]);
    expect(jobs.prices.mock.invocationCallOrder[0]).toBeLessThan(jobs.anomalies.mock.invocationCallOrder[0]);
  });
  it("never bypasses an unavailable or unauthorized admission fence",async()=>{
    const rpc=vi.fn(async()=>({data:null,error:{code:"42501"}}));
    await expect(refreshDerivedForBusiness({rpc} as never,"cafe-one","UTC",date)).rejects.toThrow("derived_refresh_admission_failed");
    expect(jobs.shifts).not.toHaveBeenCalled();
  });
  it("keeps independent work and failed receipt even when an alert reader fails",async()=>{
    const rpc=vi.fn(async(name:string)=>name==="supervisor_claim_derived_refresh"?
      {data:{token:"lease-a"},error:null}:{data:{accepted:true,pending:true},error:null});
    jobs.alerts.mockRejectedValueOnce(new Error("reader unavailable"));
    await expect(refreshDerivedForBusiness({rpc} as never,"cafe-one","UTC",date)).rejects.toThrow("reader unavailable");
    expect(jobs.prices).toHaveBeenCalledOnce();
    expect(jobs.anomalies).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenLastCalledWith("supervisor_finish_derived_refresh",{p_business_id:"cafe-one",p_token:"lease-a",p_success:false});
  });
  it("fails if a stale token cannot acknowledge completion",async()=>{
    const rpc=vi.fn(async(name:string)=>name==="supervisor_claim_derived_refresh"?
      {data:{token:"lease-a"},error:null}:{data:{accepted:false,pending:true},error:null});
    await expect(refreshDerivedForBusiness({rpc} as never,"cafe-one","UTC",date)).rejects.toThrow("derived_refresh_ack_failed");
  });
});
