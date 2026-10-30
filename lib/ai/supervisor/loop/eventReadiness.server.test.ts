import {describe,expect,it} from "vitest";
import {eventReadinessCapability,eventReadinessCapabilityId,eventReadinessInput,eventReadinessEffect}
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
   result:{observedDays:1,expectedDays:2,missingBaselineDays:["2026-10-31"]}});
  const early=await eventReadinessCapability.report(scope,effect,[sample],false);
  expect(early.status).toBe("in_progress");
 });
 it("reports complete only after every event day has actual evidence and a baseline",async()=>{
  const sample=(date:string)=>({businessDate:date,source:"hourly_sales_rollup+daily_rollups",
    observation:{coverage:"actual",actualCents:130000,typicalCents:100000}});
  const report=await eventReadinessCapability.report(scope,effect,
    [sample("2026-11-01"),sample("2026-10-31")],true);
  expect(report).toMatchObject({status:"complete",source:"hourly_sales_rollup+daily_rollups",
   result:{observedDays:2,expectedDays:2,days:[{date:"2026-10-31"},{date:"2026-11-01"}]}});
 });
});
