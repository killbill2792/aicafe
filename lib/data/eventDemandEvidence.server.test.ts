import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const reads=vi.hoisted(()=>({
  daily:vi.fn(),hourly:vi.fn(),events:vi.fn(),proposals:vi.fn(),reports:vi.fn(),
  facts:vi.fn(),live:vi.fn(),trust:vi.fn(),
}));
vi.mock("./dailyFacts.server",()=>({readDailyFacts:reads.daily}));
vi.mock("./toastDayTrust.server",()=>({readToastDayTrust:reads.trust}));
vi.mock("./posFactReaders.server",()=>({posFactReaders:()=>({peakHours:reads.hourly})}));
vi.mock("./cafeEvents.server",()=>({readCafeEvents:reads.events}));
vi.mock("./todayLive.server",()=>({readSavedTodayLive:reads.live}));
vi.mock("@/lib/ownerFacts/store.server",()=>({loadOwnerFacts:reads.facts}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({
  readOwnerProposals:reads.proposals,readOwnerReports:reads.reports,
}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {readEventDemandEvidence} from "./eventDemandEvidence.server";

const request={eventDate:"2026-11-02",asOfDate:"2026-11-01",eventIds:["event-a"],
  eventNames:["Parade"]};
const ownerA={businessId:"cafe-a",ownerUserId:"owner-a"};
const ownerB={businessId:"cafe-b",ownerUserId:"owner-b"};
function fakeDb(authorized=true,observations:unknown[]=[]) {
  const selectors:Array<{table:string;column:string;value:unknown}>=[];
  const from=(table:string)=>{
    const q={select:()=>q,
      eq:(column:string,value:unknown)=>{selectors.push({table,column,value});return q;},
      in:()=>q,lte:()=>q,order:()=>q,
      maybeSingle:async()=>({data:authorized?{role:"owner"}:null,error:null}),
      limit:async()=>({data:observations,error:null}),
    };
    return q;
  };
  return {db:{from} as unknown as SupabaseClient,selectors};
}
const proposal={id:"prior",thread_id:"thread",capability_id:"alex.event_readiness.v1",
  revision:1,status:"draft",canonical_effect_payload:{startDate:"2025-11-03",
    endDate:"2025-11-03",facts:[{id:"old",name:"Parade"}]},
  baseline:null,monitor_spec:null,monitoring_start_date:null,created_at:"2025-11-04T00:00:00Z"};
beforeEach(()=>{
  vi.resetAllMocks();
  reads.daily.mockResolvedValue([
    {date:"2026-10-12",netSalesCents:10000,salesDataStatus:"actual"},
    {date:"2026-10-19",netSalesCents:12000,salesDataStatus:"actual"},
    {date:"2026-10-26",netSalesCents:11000,salesDataStatus:"actual"},
  ]);
  reads.hourly.mockResolvedValue({available:true,value:{hours:[
    {date:"2026-10-12",hourLocal:9,netSalesCents:10000},
    {date:"2026-10-19",hourLocal:9,netSalesCents:12000},
    {date:"2026-10-26",hourLocal:9,netSalesCents:11000},
  ]},quality:{missingInputs:[],notes:[]}});
  reads.events.mockResolvedValue([]);
  reads.proposals.mockResolvedValue([proposal]);
  reads.reports.mockResolvedValue([{proposal_id:"prior",status:"complete",
    generated_at:"2025-11-04T00:00:00Z",report:{observedDays:1,expectedDays:1,
      days:[{date:"2025-11-03",actualCents:16000,typicalCents:13000}]}}]);
  reads.facts.mockResolvedValue([]);
  reads.live.mockResolvedValue(null);
  reads.trust.mockResolvedValue({quality:[],notes:[]});
});

describe("LDI D — authorized composite reader / PR F contract",()=>{
  it("rejects an unauthorized owner before reading any café facts",async()=>{
    await expect(readEventDemandEvidence(fakeDb(false).db,ownerA,request))
      .rejects.toThrow("event_evidence_owner_required");
    expect(reads.daily).not.toHaveBeenCalled();
    expect(reads.proposals).not.toHaveBeenCalled();
  });
  it("restricts every source to the requested café and owner, including samples",async()=>{
    for(const owner of [ownerA,ownerB]){
      const fixture=fakeDb(true,[{proposal_id:"prior",business_date:"2025-11-03",
        evidence_source:"daily_rollups",observation:{coverage:"actual",actualCents:16000}}]);
      const result=await readEventDemandEvidence(fixture.db,owner,request);
      expect(result.normal.netSalesCents).toBe(11000);
      expect(result.priorOutcomes).toMatchObject([{proposalId:"prior",matchedBy:"event_name",
        observations:[{actualCents:16000,coverage:"actual"}]}]);
      expect(reads.daily).toHaveBeenCalledWith(fixture.db,owner.businessId,
        "2026-09-07","2026-11-01");
      expect(reads.proposals).toHaveBeenCalledWith(fixture.db,owner,
        {capabilityId:"alex.event_readiness.v1",limit:200});
      expect(reads.facts).toHaveBeenCalledWith(owner.businessId,fixture.db);
      expect(fixture.selectors).toEqual(expect.arrayContaining([
        {table:"memberships",column:"business_id",value:owner.businessId},
        {table:"memberships",column:"user_id",value:owner.ownerUserId},
        {table:"supervisor_monitor_samples",column:"business_id",value:owner.businessId},
      ]));
      expect(fixture.selectors.filter(q=>q.table==="supervisor_monitor_samples"&&
        q.column==="business_id")).toHaveLength(1);
    }
  });
  it("downgrades missing source reads instead of converting unknown to zero",async()=>{
    reads.daily.mockRejectedValueOnce(new Error("Toast unavailable"));
    reads.facts.mockRejectedValueOnce(new Error("Owner facts unavailable"));
    reads.reports.mockRejectedValueOnce(new Error("Report unavailable"));
    const result=await readEventDemandEvidence(fakeDb().db,ownerA,request);
    expect(result.normal.netSalesCents).toBeNull();
    expect(result.observed).toBeNull();
    expect(result.coverage.missing).toEqual(expect.arrayContaining([
      "daily_sales_unavailable","owner_facts_unavailable","prior_event_reports_unavailable",
      "insufficient_comparable_actual_weekdays",
    ]));
    expect(result.ownerObservations).toEqual([]);
    expect(result.attribution).toBe("not_established");
  });
  it("no owner feedback is a valid successful case and does not block prior report reuse",async()=>{
    reads.facts.mockResolvedValueOnce([]);
    const result=await readEventDemandEvidence(fakeDb().db,ownerA,request);
    expect(result.ownerObservations).toEqual([]);
    expect(result.priorOutcomes[0]).toMatchObject({reportStatus:"complete",observedDays:1});
    expect(result.coverage.missing).not.toContain("owner_facts_unavailable");
  });
});
