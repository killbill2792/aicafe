import {describe,expect,it} from "vitest";
import {assembleEventDemandEvidence,eventDemandWindow,checkedEventDemandRequest}
  from "./eventDemandEvidence";
import type {DailyFacts} from "../calc";
import type {Hour} from "../data/posFactReaders.server";
import type {CafeEvent} from "../data/cafeEvents.server";
import type {OwnerProposalRow} from "../ai/supervisor/loop/reads.server";

const date="2026-11-02",asOf="2026-11-01";
const request={eventDate:date,asOfDate:asOf,eventIds:["current-id"],eventNames:["City Parade"]};
const day=(date:string,netSalesCents:number,status:"actual"|"missing"="actual")=>
  ({date,netSalesCents,salesDataStatus:status}) as DailyFacts;
const days=[day("2026-10-12",10000),day("2026-10-19",11000),day("2026-10-26",12000)];
const hours:Hour[]=days.map(d=>({date:d.date,hourLocal:9,netSalesCents:d.netSalesCents,
  ordersCount:2,locationId:null}));
const event=(id:string,name:string,startDate=date):CafeEvent=>({id,name,kind:"public_event",
  startDate,endDate:startDate,startTime:null,endTime:null,venue:null,venueAddress:null,
  areaLabel:null,sourceUrl:null,status:"found",foundAt:asOf,lastCheckedAt:asOf});
const proposal=(id:string,startDate:string,events:{id:string;name:string}[]):OwnerProposalRow=>({
  id,thread_id:"thread",capability_id:"alex.event_readiness.v1",revision:1,status:"draft",
  canonical_effect_payload:{startDate,endDate:startDate,eventIds:events.map(e=>e.id),facts:events},
  baseline:{},monitor_spec:{},monitoring_start_date:null,created_at:startDate+"T12:00:00Z",
});
const inputs=(over:Partial<Parameters<typeof assembleEventDemandEvidence>[1]>={})=>({
  daily:days,hourly:hours,baselineEvents:[] as CafeEvent[],dayEvents:[event("current-id","City Parade")],
  proposals:[] as OwnerProposalRow[],reports:[],samples:[],ownerFacts:[],...over,
});

describe("LDI D — pure canonical performance evidence",()=>{
  it("uses the existing same-weekday median and only reconciled hourly days",()=>{
    const result=assembleEventDemandEvidence(request,inputs());
    expect(result.normal).toMatchObject({netSalesCents:11000,sampleDays:3,requiredDays:3,
      source:"daily_rollups",status:"actual"});
    expect(result.usualHours).toEqual([{hourLocal:9,netSalesCents:11000,sampleDays:3}]);
    expect(result.observed).toBeNull();
    expect(result.ownerObservations).toEqual([]);
    expect(result.attribution).toBe("not_established");
  });
  it("does not certify an incomplete Toast history or missing hourly reconciliation",()=>{
    const partial=assembleEventDemandEvidence(request,inputs({
      daily:[day("2026-10-12",10000),day("2026-10-19",0,"missing")],
      hourly:[hours[0]],missing:["toastImportIncompleteDays:1:2026-10-19:0"],
    }));
    expect(partial.normal).toMatchObject({netSalesCents:null,sampleDays:1,status:"missing"});
    expect(partial.coverage.missing).toContain("insufficient_comparable_actual_weekdays");
    expect(partial.coverage.missing).toContain("hourly_pattern_not_verified");
    const unreconciled=assembleEventDemandEvidence(request,inputs({hourly:[...hours.slice(0,2),
      {...hours[2],netSalesCents:999}]}));
    expect(unreconciled.normal.netSalesCents).toBe(11000);
    expect(unreconciled.usualHours).toEqual([]);
    expect(unreconciled.coverage.hourlyReconciledDays).toBe(2);
  });
  it("excludes known event days, not arbitrary dates, from the comparable baseline",()=>{
    const result=assembleEventDemandEvidence(request,inputs({
      baselineEvents:[event("past-event","Another public event","2026-10-12")],
    }));
    expect(result.normal.sampleDays).toBe(2);
    expect(result.normal.netSalesCents).toBeNull();
    expect(result.coverage.missing).toContain("insufficient_comparable_actual_weekdays");
  });
  it("reuses prior report and monitoring facts, names recurrence uncertainty, and shows rival events",()=>{
    const past=proposal("prior-plan","2025-11-03",[{id:"old-id",name:"City Parade"}]);
    const now=proposal("current-plan",date,[{id:"current-id",name:"City Parade"}]);
    const result=assembleEventDemandEvidence(request,inputs({
      proposals:[now,past],dayEvents:[event("current-id","City Parade"),event("game","University game")],
      reports:[{proposal_id:"prior-plan",status:"insufficient_evidence",generated_at:"2025-11-04T00:00:00Z",
        report:{observedDays:1,expectedDays:2,days:[{date:"2025-11-03",actualCents:20000,
          typicalCents:null}]}}],
      samples:[{proposal_id:"prior-plan",business_date:"2025-11-03",evidence_source:"daily_rollups",
        observation:{coverage:"actual",actualCents:20000,typicalCents:null}},
        {proposal_id:"current-plan",business_date:date,evidence_source:"toast_today_live",
          observation:{coverage:"provisional",actualCents:3000,typicalCents:8000}}],
      ownerFacts:[{fact_key:"event_outcome:City Parade",value_json:{note:"Busy but a storm"},
        created_at:"2025-11-04",unit:null,period_scope:null}],
    }));
    expect(result.priorOutcomes).toMatchObject([{proposalId:"prior-plan",matchedBy:"event_name",
      reportStatus:"insufficient_evidence",observedDays:1,expectedDays:2,
      days:[{actualCents:20000,typicalCents:null}]}]);
    // A future-dated monitoring sample must not be treated as an observed sale yet.
    expect(result.currentObservations).toEqual([]);
    expect(result.otherKnownEvents).toEqual(["University game"]);
    expect(result.coverage.caveats).toContain("other_events_on_same_day_not_controlled_for");
    expect(result.ownerObservations[0]).toMatchObject({origin:"owner_reported",
      value:{note:"Busy but a storm"}});
    expect(result.attribution).toBe("not_established");
  });
  it("actual day defeats a live estimate; stale, incomplete or other-day Toast stays unknown",()=>{
    const yesterday={netSalesCents:9000,businessDate:date,readAt:"2026-11-02T18:00:00Z",
      ageMs:2000,truncated:false,unparsedOrders:0,locationsFailed:0};
    const historical={eventDate:"2026-10-26",asOfDate:asOf};
    const actual=assembleEventDemandEvidence(historical,inputs({
      daily:[...days,day("2026-10-26",12000)],live:yesterday,
    }));
    expect(actual.observed).toMatchObject({coverage:"actual",netSalesCents:12000,
      source:"daily_rollups"});
    const provisional=assembleEventDemandEvidence({eventDate:date,asOfDate:date},
      inputs({live:yesterday}));
    expect(provisional.observed).toMatchObject({coverage:"provisional",netSalesCents:9000});
    const stale=assembleEventDemandEvidence({eventDate:date,asOfDate:date},inputs({
      live:{...yesterday,ageMs:25*60_000},
    }));
    expect(stale.observed).toBeNull();
    expect(stale.coverage.caveats).toContain("live_reading_incomplete_or_stale");
  });
  it("rejects invalid scope and never silently extends the eight-week baseline",()=>{
    expect(()=>checkedEventDemandRequest({...request,eventDate:"2026-02-30"})).toThrow();
    expect(()=>checkedEventDemandRequest({...request,eventIds:Array(9).fill("id")})).toThrow();
    expect(eventDemandWindow(request)).toEqual({from:"2026-09-07",through:"2026-11-01",
      before:"2026-11-02",dailyThrough:"2026-11-01"});
  });
});
