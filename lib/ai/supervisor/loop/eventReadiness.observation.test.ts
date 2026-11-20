import {describe,expect,it,vi,beforeEach} from "vitest";
import {effectHash,type LoopProposal} from "./engine";
import {readOnlyEventObservation,selectEventObservations,observedEventProposalIds,
  eventToastEvidence,eventReadinessCapabilityId} from "./eventReadiness.server";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import {readItemSales,readDiscounts,readLaborEntries,readMenu}
  from "@/lib/data/canonical/reads.server";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/canonical/reads.server",()=>({
  readItemSales:vi.fn(),readDiscounts:vi.fn(),readLaborEntries:vi.fn(),readMenu:vi.fn(),
}));
const date="2026-10-31";
const effect={
  startDate:date,endDate:date,
  eventIds:["11111111-1111-4111-8111-111111111111"],
  summary:"Consider preparations for the parade",
  expectedBusyHours:[],
  actions:[{area:"promo",action:"Consider a holiday offer",reason:"Nearby parade crowds"}],
  facts:[{id:"11111111-1111-4111-8111-111111111111",name:"Parade",
    kind:"parade",startDate:date,endDate:date,venue:null,areaLabel:null,
    sourceUrl:null}],
  factsHash:"a".repeat(64),
};
function proposal(status:LoopProposal["status"]="draft",id="plan"):LoopProposal{
  return {id,businessId:"11111111-1111-4111-8111-111111111111",
    ownerUserId:"22222222-2222-4222-8222-222222222222",
    threadId:"33333333-3333-4333-8333-333333333333",
    capabilityId:eventReadinessCapabilityId,capabilityVersion:1,
    canonicalEffectPayload:effect,effectHash:effectHash(effect),
    baseline:{},monitorSpec:{durationDays:1,metricScope:"event"},
    status,revision:1,locale:"en",monitoringStartDate:null,
    createdAt:"2026-10-30T00:00:00Z"};
}
describe("saved event observation is never owner approval",()=>{
  it("observes inert future/event-day drafts without persisting an approval or commit",()=>{
    const draft=proposal();
    const observation=readOnlyEventObservation(draft)!;
    expect(observation).toMatchObject({status:"committed",monitoringStartDate:date});
    expect(draft).toMatchObject({status:"draft",monitoringStartDate:null,revision:1});
    expect(observation).not.toBe(draft);
    expect(selectEventObservations([draft])).toEqual([observation]);
    expect(selectEventObservations([proposal("draft","revised"),draft],
      new Set([draft.id])).map(x=>x.id)).toEqual([draft.id]);
  });
  it("keeps owner decisions and forbids stale, rejected, altered and unrelated effects",()=>{
    expect(readOnlyEventObservation(proposal("rejected"))).toBeNull();
    expect(readOnlyEventObservation(proposal("stale"))).toBeNull();
    expect(readOnlyEventObservation({...proposal(),effectHash:"f".repeat(64)})).toBeNull();
    expect(readOnlyEventObservation({...proposal(),capabilityId:"alex.price.v1"})).toBeNull();
    expect(selectEventObservations([proposal("draft","new"),
      proposal("committed","approved")]).map(x=>x.id)).toEqual(["approved"]);
  });
  it("sticks to the originally sampled proposal after a newer draft revision",async()=>{
    const earlier=proposal("draft","first");
    const later={...proposal("draft","second"),createdAt:"2026-10-31T00:00:00Z"};
    const db={from(table:string){
      expect(table).toBe("supervisor_monitor_samples");
      const q={select:()=>q,eq:()=>q,in:()=>q,
        limit:async()=>({data:[{proposal_id:earlier.id}],error:null})};
      return q;
    }};
    const ids=await observedEventProposalIds(db as never,earlier.businessId,
      [earlier.id,later.id]);
    expect(ids).toEqual(new Set([earlier.id]));
    expect(selectEventObservations([later,earlier],ids).map(x=>x.id)).toEqual(
      [earlier.id]);
  });
  it("allocates overlap to a single café-date monitor and honors already sampled dates",()=>{
    const longEffect={...effect,endDate:"2026-11-02"};
    const span={...proposal("draft","span"),canonicalEffectPayload:longEffect,
      effectHash:effectHash(longEffect),monitorSpec:{durationDays:3,metricScope:"event"}};
    const secondEffect={...effect,startDate:"2026-11-01",endDate:"2026-11-01"};
    const second={...proposal("draft","second"),canonicalEffectPayload:secondEffect,effectHash:effectHash(secondEffect)};
    expect(selectEventObservations([second,span],new Set(),"2026-11-01").map(x=>x.id)).toEqual(["span"]);
    expect(selectEventObservations([second,span],new Set(["span"]),"2026-11-01",new Set(["second"])).map(x=>x.id)).toEqual(["second"]);
    expect(selectEventObservations([second,span],new Set(),"2026-11-02").map(x=>x.id)).toEqual(["span"]);
  });
  it("elects an active occurrence instead of a sampled cancelled, shortened or moved one",()=>{
    const day="2026-11-01",oldId=effect.eventIds[0],newId="22222222-2222-4222-8222-222222222223";
    const fact:CafeEvent={...effect.facts[0],startTime:null,endTime:null,venueAddress:null,
      status:"found",foundAt:"",lastCheckedAt:"",endDate:"2026-11-02"};
    const spanEffect={...effect,endDate:"2026-11-02",facts:[{...effect.facts[0],endDate:"2026-11-02"}]};
    const span={...proposal("draft","span"),canonicalEffectPayload:spanEffect,effectHash:effectHash(spanEffect),
      monitorSpec:{durationDays:3,metricScope:"event"}};
    const nextEffect={...effect,startDate:day,endDate:day,eventIds:[newId],
      facts:[{...effect.facts[0],id:newId,startDate:day,endDate:day}]};
    const next={...proposal("draft","next"),canonicalEffectPayload:nextEffect,effectHash:effectHash(nextEffect)};
    const active={...fact,id:newId,startDate:day,endDate:day};
    for(const changed of [
      {...fact,status:"cancelled" as const},
      {...fact,endDate:date},
      {...fact,startDate:"2026-11-04",endDate:"2026-11-05"},
    ]){
      const current=new Map([[oldId,changed],[newId,active]]);
      expect(selectEventObservations([span,next],new Set(["span"]),day,new Set(["span"]),current,day,"America/Los_Angeles").map(p=>p.id)).toEqual(["next"]);
    }
    expect(selectEventObservations([span,next],new Set(["span"]),day,new Set(),new Map([[newId,active]]),day,"America/Los_Angeles").map(p=>p.id)).toEqual(["next"]);
  });
  it("does not treat an inactive status sample as sales ownership",async()=>{
    const db={from(){const q={select:()=>q,eq:()=>q,in:()=>q,limit:async()=>({data:[
      {proposal_id:"inactive",business_date:date,observation:{coverage:"event_inactive"}},
      {proposal_id:"active",business_date:date,observation:{coverage:"actual"}},
    ],error:null})};return q;}};
    expect(await observedEventProposalIds(db as never,proposal().businessId,["inactive","active"])).toEqual(new Set(["active"]));
  });
  it("does not multiply a day monitor when cron receives duplicate saved drafts",()=>{
    expect(selectEventObservations([proposal("draft","older"),proposal("draft","newer")]))
      .toHaveLength(1);
  });
});
const ready=(rows:Record<string,unknown>[],truncated=false)=>({
  rows,truncated,error:undefined,empty:rows.length===0,rowCount:rows.length,notes:[],
});
beforeEach(()=>{vi.resetAllMocks();});
describe("canonical Toast item/discount/shift evidence",()=>{
  it("distinguishes named discount and combo adoption from ordinary item/discount totals",async()=>{
    vi.mocked(readItemSales).mockResolvedValue(ready([
      {source:"toast",status:"actual",data:{name:"Latte",quantity:2}},
    ]));
    vi.mocked(readMenu).mockResolvedValue(ready([
      {source:"toast",status:"actual",data:{name:"Latte"}},
    ]));
    vi.mocked(readDiscounts).mockResolvedValue(ready([
      {source:"toast",status:"actual",amount_cents:250,data:{order_id:"o"},
        check_discounts:[{name:"Parade Special",amountCents:250,level:"check"}]},
    ]));
    vi.mocked(readLaborEntries).mockResolvedValue(ready([
      {source:"toast",status:"actual",data:{
        clock_in:"2026-10-31T12:00:00Z",clock_out:"2026-10-31T17:00:00Z"}},
      {source:"toast",status:"needs_match",data:{
        clock_in:"2026-10-31T14:00:00Z",clock_out:"2026-10-31T18:00:00Z"}},
      {source:"toast",status:"estimated",data:{
        clock_in:"2026-10-31T15:00:00Z",clock_out:"2026-10-31T19:00:00Z"}},
    ]));
    const evidence=await eventToastEvidence({} as never,proposal().businessId,date,
      [{area:"promo",action:"Offer Parade Special discount"}]);
    expect(evidence.itemSales).toEqual({coverage:"verified",
      items:[{name:"Latte",quantity:2}]});
    expect(evidence.discountAmounts).toEqual({coverage:"verified",observedOrders:1});
    expect(evidence.namedDiscounts).toEqual({coverage:"verified",
      names:["Parade Special"],matchedRecommendationNames:["Parade Special"]});
    expect(evidence.laborEntries).toEqual({coverage:"verified",
      recordedShifts:3,wageCoverage:"partial"});
    expect(evidence.recommendedComboImplemented).toBe("unverified");
    expect(evidence.recommendedDiscountImplemented).toBe("verified");
    expect(evidence.physicalPreparationImplemented).toBe("unverified");
  });
  it("reads non-sales evidence across every event date and retains independent facts on one source failure",async()=>{
    const rows=[{source:"toast",status:"actual",data:{name:"Latte",quantity:2}},
      {source:"toast",status:"actual",data:{name:"Latte",quantity:3}}];
    vi.mocked(readItemSales).mockResolvedValue(ready(rows));
    vi.mocked(readMenu).mockResolvedValue(ready([{source:"toast",status:"actual",data:{name:"Latte"}}]));
    vi.mocked(readLaborEntries).mockResolvedValue(ready([]));
    vi.mocked(readDiscounts).mockRejectedValue(new Error("source unavailable"));
    const evidence=await eventToastEvidence({} as never,proposal().businessId,date,[],"2026-11-02");
    expect(readItemSales).toHaveBeenCalledWith({},proposal().businessId,{dateFrom:date,dateTo:"2026-11-02"});
    expect(evidence.itemSales).toEqual({coverage:"verified",items:[{name:"Latte",quantity:5}]});
    expect(evidence.namedDiscounts.coverage).toBe("partial");
  });
  it("excludes cancelled dates and undated rows from event-period non-sales evidence",async()=>{
    const excluded="2026-11-01",end="2026-11-02";
    vi.mocked(readItemSales).mockResolvedValue(ready([
      {source:"toast",status:"actual",business_date:date,data:{name:"Latte",quantity:2}},
      {source:"toast",status:"actual",business_date:excluded,data:{name:"Latte",quantity:99}},
      {source:"toast",status:"actual",business_date:end,data:{name:"Latte",quantity:3}},
      {source:"toast",status:"actual",data:{name:"Latte",quantity:99}},
    ]));
    vi.mocked(readMenu).mockResolvedValue(ready([{source:"toast",status:"actual",data:{name:"Latte"}}]));
    vi.mocked(readDiscounts).mockResolvedValue(ready([{source:"toast",status:"actual",business_date:excluded,amount_cents:100,
      check_discounts:[{name:"Off-event discount",amountCents:100}]}]));
    vi.mocked(readLaborEntries).mockResolvedValue(ready([
      {source:"toast",status:"actual",business_date:date,data:{clock_in:"2026-10-31T12:00:00Z",clock_out:"2026-10-31T17:00:00Z"}},
      {source:"toast",status:"actual",business_date:excluded,data:{clock_in:"2026-11-01T12:00:00Z",clock_out:"2026-11-01T17:00:00Z"}},
    ]));
    const result=await eventToastEvidence({} as never,proposal().businessId,date,[],end,new Set([excluded]));
    expect(result.itemSales).toEqual({coverage:"partial",items:[{name:"Latte",quantity:5}]});
    expect(result.namedDiscounts.names).toEqual([]);
    expect(result.discountAmounts.observedOrders).toBe(0);
    expect(result.laborEntries.recordedShifts).toBe(1);
  });
  it("does not assert full item coverage on a capped Toast read",async()=>{
    vi.mocked(readItemSales).mockResolvedValue(ready([
      {source:"toast",status:"actual",data:{name:"Latte",quantity:1}},
    ],true));
    vi.mocked(readMenu).mockResolvedValue(ready([
      {source:"toast",status:"actual",data:{name:"Latte"}},
    ]));
    vi.mocked(readDiscounts).mockResolvedValue(ready([]));
    vi.mocked(readLaborEntries).mockResolvedValue(ready([]));
    const result=await eventToastEvidence({} as never,proposal().businessId,date);
    expect(result.itemSales.coverage).toBe("partial");
    expect(result.discountAmounts.coverage).toBe("missing");
    expect(result.laborEntries.coverage).toBe("missing");
    expect(result.namedDiscounts.coverage).toBe("missing");
  });
});
