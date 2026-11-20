import {describe,expect,it} from "vitest";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import {eventReadinessCapability,eventReadinessCapabilityId,eventReadinessInput,eventReadinessEffect,eventDailyOnlyComparison,eventStatusAtBusinessDay,eventDayActivity,eventWindowAtBusinessDay}
 from "./eventReadiness.server";

const eventId="11111111-1111-4111-8111-111111111111";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const valid={startDate:"2026-10-31",endDate:"2026-11-01",eventIds:[eventId],
 summary:"Prepare for the holiday crowds",
 expectedBusyHours:[{start:"11:00",end:"15:00"}],
 actions:[{area:"staff" as const,action:"Ask for backup coverage",reason:"A parade is nearby"}]};
const effect=eventReadinessEffect.parse({...valid,
 facts:[{id:eventId,name:"Parade",kind:"parade",startDate:"2026-10-31",
   endDate:"2026-11-01",venue:"Square",areaLabel:"Downtown",sourceUrl:"https://example.org/parade"}],
 factsHash:"a".repeat(64)});

describe("event_readiness uses the shared Supervisor lifecycle",()=>{
 it("validates inert one-to-three action plans with time ranges",()=>{
  expect(eventReadinessCapabilityId).toBe("alex.event_readiness.v1");
  expect(eventReadinessInput.parse(valid).actions).toHaveLength(1);
  expect(eventReadinessInput.parse({...valid,importance:"high"}).importance).toBe("high");
  expect(()=>eventReadinessInput.parse({...valid,importance:"certain"})).toThrow();
  expect(()=>eventReadinessInput.parse({...valid,actions:[]})).toThrow();
  expect(()=>eventReadinessInput.parse({...valid,eventIds:[eventId,eventId],x:"override"})).toThrow();
 });
 it("approval never writes to Toast, staff, or a separate event plan ledger",async()=>{
  expect(await eventReadinessCapability.commit(scope,effect)).toEqual({
   status:"verified",evidenceSource:"event_readiness",monitoringStartDate:"2026-10-31"});
  expect(eventReadinessCapability.dependencyScope(effect)).toEqual({
   kind:"event_readiness",eventIds:[eventId],start:"2026-10-31",end:"2026-11-01"});
 });
 it("preserves missing actual days and baselines rather than inventing zero",async()=>{
  const sample={businessDate:"2026-10-31",source:"hourly_sales_rollup+daily_rollups",
   observation:{coverage:"actual",actualCents:130000,typicalCents:null}};
  const result=await eventReadinessCapability.report(scope,effect,[sample],true);
  expect(result).toMatchObject({status:"insufficient_evidence",recommendation:"adjust",
   result:{observedDays:1,expectedDays:2,missingBaselineDays:["2026-10-31"],
     salesSummary:{observedSalesCents:130000,observedSalesDays:1,comparableDays:0,
       comparableActualCents:null,comparableTypicalCents:null,changePercent:null}}});
  const early=await eventReadinessCapability.report(scope,effect,[sample],false);
  expect(early.status).toBe("in_progress");
 });
 it("retains independently certified daily totals without hourly or exclusion evidence",()=>{
  const days=[{date:"2026-11-05",netSalesCents:10000},{date:"2026-11-12",netSalesCents:12000},
    {date:"2026-11-19",netSalesCents:14000},{date:"2026-11-26",netSalesCents:18000}];
  expect(eventDailyOnlyComparison(days,"2026-11-26",new Set())).toEqual({actualCents:18000,
    typicalCents:12000,changePercent:50,baselineDays:3,hours:[],hourlyCoverage:"missing"});
  expect(eventDailyOnlyComparison(days,"2026-11-26",null)).toMatchObject({actualCents:18000,
    typicalCents:null,changePercent:null,baselineDays:0});
  expect(eventDailyOnlyComparison(days,"2026-11-27",new Set())).toBeNull();
 });
 it("reports complete only after every event day has actual evidence and a baseline",async()=>{
  const sample=(date:string)=>({businessDate:date,source:"hourly_sales_rollup+daily_rollups",
    observation:{coverage:"actual",actualCents:130000,typicalCents:100000}});
  const report=await eventReadinessCapability.report(scope,effect,
    [sample("2026-11-01"),sample("2026-10-31"),sample("2026-10-31")],true);
  expect(report).toMatchObject({status:"complete",source:"hourly_sales_rollup+daily_rollups",
   result:{observedDays:2,expectedDays:2,days:[{date:"2026-10-31"},{date:"2026-11-01"}],
     salesSummary:{observedSalesCents:260000,observedSalesDays:2,comparableDays:2,
       comparableActualCents:260000,comparableTypicalCents:200000,changePercent:30}}});
 });
});

 describe("cancellation-aware monitoring",()=>{
  const event:CafeEvent={id:eventId,name:"Parade",kind:"parade",startDate:"2026-10-31",endDate:"2026-11-02",startTime:null,endTime:null,venue:null,venueAddress:null,areaLabel:null,sourceUrl:null,status:"cancelled",foundAt:"2026-10-30T00:00:00Z",lastCheckedAt:"2026-11-02T00:00:00Z",verificationDetails:{history:[{verifiedAt:"2026-11-02T06:30:00Z",previousStatus:"found",status:"cancelled"}]}};
  it("uses the café-local change date, preserves earlier observed dates and fails closed on unknown identity",()=>{
    expect(eventStatusAtBusinessDay(event,"2026-10-31","America/Los_Angeles")).toBe("found");
    expect(eventDayActivity([event],"2026-11-01","America/Los_Angeles")).toBe("inactive");
    expect(eventDayActivity([event],"2026-11-01","UTC")).toBe("active");
    expect(eventDayActivity([null],"2026-11-01","UTC")).toBe("unconfirmed");
    expect(eventDayActivity([event,{...event,status:"found",verificationDetails:null}],"2026-11-02","UTC")).toBe("active");
  });
  it("retains earlier-day evidence when the same event is officially moved later",()=>{
    const moved={...event,status:"found" as const,startDate:"2026-11-04",endDate:"2026-11-05",verificationDetails:{history:[{verifiedAt:"2026-11-02T12:00:00Z",previousStatus:"found",status:"found",previousStartDate:"2026-10-31",previousEndDate:"2026-11-02",newDate:"2026-11-04",newEndDate:"2026-11-05"}]}};
    expect(eventWindowAtBusinessDay(moved,"2026-11-01","UTC")).toEqual({status:"found",startDate:"2026-10-31",endDate:"2026-11-02"});
    expect(eventDayActivity([moved],"2026-11-02","UTC")).toBe("inactive");
    expect(eventDayActivity([moved],"2026-11-04","UTC")).toBe("active");
  });
  it("uses the café-local timed interval both before and after a source-timezone correction",()=>{
    const timed={...event,status:"found" as const,startDate:"2026-11-03",endDate:"2026-11-03",
      verificationDetails:{history:[{verifiedAt:"2026-11-02T12:00:00Z",previousStatus:"found",status:"found",
        previousStartDate:"2026-11-02",previousEndDate:"2026-11-02",
        previousStartAt:"2026-11-02T01:00:00Z",previousEndAt:"2026-11-02T03:00:00Z",
        newDate:"2026-11-04",newEndDate:"2026-11-04",newStartAt:"2026-11-04T01:00:00Z",newEndAt:"2026-11-04T03:00:00Z"}]}};
    expect(eventDayActivity([timed],"2026-11-01","America/Los_Angeles")).toBe("active");
    expect(eventDayActivity([timed],"2026-11-03","America/Los_Angeles")).toBe("active");
    expect(eventDayActivity([timed],"2026-11-04","America/Los_Angeles")).toBe("inactive");
  });
  it("does not count a cancelled day as zero sales or a completed observation",async()=>{
    const report=await eventReadinessCapability.report(scope,effect,[{businessDate:"2026-10-31",source:"daily_rollups",observation:{coverage:"actual",actualCents:12300,typicalCents:10000}},{businessDate:"2026-11-01",source:"cafe_events",observation:{coverage:"event_inactive",eventActivity:"inactive"}}],true);
    expect(report).toMatchObject({status:"insufficient_evidence",result:{observedDays:1,expectedDays:2,eventStatusDays:[{date:"2026-11-01",activity:"inactive"}],salesSummary:{observedSalesCents:12300,observedSalesDays:1}}});
  });
 });
