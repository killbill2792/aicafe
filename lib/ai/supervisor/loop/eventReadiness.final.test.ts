import {describe,expect,it,vi} from "vitest";
import {eventReadinessCapability,eventReadinessEffect} from "./eventReadiness.server";
import {eventFinalNarrative} from "@/lib/events/eventFinalReport.server";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/events/eventFinalReport.server",()=>({
  eventFinalNarrative:vi.fn(async()=>({text:"The AI reviewed this day's results.",hash:"h".repeat(64),
    provenance:[],evidence:[]})),
  eventReportFactsHash:vi.fn(()=>"h".repeat(64)),
  eventReportFallback:vi.fn(()=>"Certified event results are ready."),
  eventReportNumericEvidence:vi.fn(()=>[]),
}));
vi.mock("@/lib/data/cafeEvents.server",()=>({
  readEventChecklist:vi.fn(async()=>[
    {actionIndex:0,state:"done"},{actionIndex:1,state:"dismissed"}]),
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:vi.fn(()=>({}))}));

const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const proposalId="44444444-4444-4444-8444-444444444444";
const effect=eventReadinessEffect.parse({
  startDate:"2026-10-31",endDate:"2026-10-31",
  eventIds:["55555555-5555-4555-8555-555555555555"],
  summary:"Prepare for the nearby event",
  expectedBusyHours:[{start:"12:00",end:"15:00"}],
  actions:[
    {area:"prep",action:"Prepare more supplies",reason:"The event is nearby"},
    {area:"hours",action:"Check operating hours",reason:"Event finish may affect access"},
  ],
  facts:[{id:"55555555-5555-4555-8555-555555555555",name:"Parade",
    kind:"public",startDate:"2026-10-31",endDate:"2026-10-31",
    venue:null,areaLabel:"Downtown",sourceUrl:null}],
  factsHash:"a".repeat(64),
});
const actual=(typicalCents:number|null)=>({
  businessDate:"2026-10-31",source:"hourly_sales_rollup+daily_rollups",
  observation:{coverage:"actual",actualCents:5000,typicalCents,
    hours:[{hourLocal:12,actualCents:2500,usualCents:typicalCents}]}});
describe("event readiness final report delivery",()=>{
  it("saves actual hourly evidence and the model's exact narrative for the morning-after inbox",async()=>{
    const report=await eventReadinessCapability.report(scope,effect,[actual(4000)],true,
      {start:"2026-10-31",through:"2026-10-31",proposalId});
    expect(report).toMatchObject({
      status:"complete",source:"hourly_sales_rollup+daily_rollups",
      result:{observedDays:1,expectedDays:1,checklist:{total:2,done:1,dismissed:1},
        reportText:"The AI reviewed this day's results.",
        days:[{date:"2026-10-31",actualCents:5000,typicalCents:4000}]},
      delivery:{agentId:"alex",taskKind:"event_plan",entityType:"event_day",
        entityId:"2026-10-31",threadText:"The AI reviewed this day's results."},
    });
    expect(eventFinalNarrative).toHaveBeenCalledTimes(1);
    expect(report.delivery?.payload).toMatchObject({eventReport:true,outcomeStatus:"complete"});
  });
  it("reports insufficient data without inventing a zero baseline or changing the plan",async()=>{
    vi.mocked(eventFinalNarrative).mockClear();
    const report=await eventReadinessCapability.report(scope,effect,[actual(null)],true,
      {start:"2026-10-31",through:"2026-10-31",proposalId});
    expect(report.status).toBe("insufficient_evidence");
    expect(report.result).toMatchObject({
      missingBaselineDays:["2026-10-31"],
      days:[{date:"2026-10-31",typicalCents:null}]});
    expect(report.delivery?.payload).toMatchObject({outcomeStatus:"insufficient_evidence"});
  });
  it("delivers a sourced, factual report when the AI narrative is unavailable",async()=>{
    vi.mocked(eventFinalNarrative).mockResolvedValueOnce(null);
    const report=await eventReadinessCapability.report(scope,effect,[actual(4000)],true,
      {start:"2026-10-31",through:"2026-10-31",proposalId});
    expect(report).toMatchObject({
      status:"complete",result:{reportText:"Certified event results are ready.",reportTextOrigin:"facts"},
      delivery:{threadText:"Certified event results are ready.",taskKind:"event_plan"}});
    expect(report.delivery?.numberProvenance).toEqual([]);
  });
  it("does not send a final report or call the model before the window closes",async()=>{
    vi.mocked(eventFinalNarrative).mockClear();
    const report=await eventReadinessCapability.report(scope,effect,[actual(4000)],false,
      {start:"2026-10-31",through:"2026-10-31",proposalId});
    expect(report.status).toBe("in_progress");
    expect(report.delivery).toBeUndefined();
    expect(eventFinalNarrative).not.toHaveBeenCalled();
  });
});
