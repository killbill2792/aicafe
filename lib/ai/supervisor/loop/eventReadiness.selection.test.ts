import {describe,it,expect} from "vitest";
import {effectHash} from "./engine";
import {eventPlanFacts,selectedEventPlanFacts,readOnlyEventObservation,
  selectEventObservations,eventReadinessEffect,eventReadinessCapabilityId} from "./eventReadiness.server";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import type {LoopProposal} from "./engine";

const a="11111111-1111-4111-8111-111111111111",
  b="22222222-2222-4222-8222-222222222222",
  date="2026-11-04";
const event=(id:string,name:string,extra:Partial<CafeEvent>={}):CafeEvent=>({
  id,name,kind:"conference",startDate:date,endDate:date,
  startTime:"10:00",endTime:"16:00",venue:"Center",
  venueAddress:"123 Main St",areaLabel:"Near downtown",sourceUrl:"https://city.example/event",
  status:"found",foundAt:"2026-10-31T00:00:00Z",lastCheckedAt:"2026-10-31T00:00:00Z",
  ...extra,
});

describe("Supervisor selects specific café-relevant events without losing the city catalog",()=>{
 const city=[event(a,"Adjacent convention"),event(b,"Distant recital",
   {venue:"Other city",venueAddress:null,startTime:null,endTime:null})];
 const hash=effectHash(eventPlanFacts(city));
 it("accepts one event of two and preserves the original event list",()=>{
   const relevant=selectedEventPlanFacts(city,city,date,hash,[a]);
   expect(relevant).toEqual(eventPlanFacts([city[0]]));
   expect(city).toHaveLength(2);
   expect(relevant).toHaveLength(1);
   expect(effectHash(relevant)).not.toBe(hash);
 });
 it("allows different cafés to make different selections of the same public city event",()=>{
   expect(selectedEventPlanFacts(city,city,date,hash,[a]).map(e=>e.id)).toEqual([a]);
   expect(selectedEventPlanFacts(city,city,date,hash,[b]).map(e=>e.id)).toEqual([b]);
 });
 it("rejects an unknown or duplicated UUID without creating a plan",()=>{
   expect(()=>selectedEventPlanFacts(city,city,date,hash,[a,a])).toThrow("event_facts_changed");
   expect(()=>selectedEventPlanFacts(city,city,date,hash,["99999999-9999-4999-8999-999999999999"]))
     .toThrow("event_facts_changed");
   expect(()=>selectedEventPlanFacts(city,city,date,hash,[])).toThrow("event_facts_changed");
 });
 it("rejects stale, cancelled, moved-day and changed venue evidence",()=>{
   expect(()=>selectedEventPlanFacts(city,[city[0],{...city[1],status:"cancelled"}],
     date,hash,[a])).toThrow("event_facts_changed");
   expect(()=>selectedEventPlanFacts(city,[{...city[0],venue:"New address"},city[1]],
     date,hash,[a])).toThrow("event_facts_changed");
   expect(()=>selectedEventPlanFacts(city,[{...city[0],startDate:"2026-11-05"},city[1]],
     date,hash,[a])).toThrow("event_facts_changed");
 });
 it("preserves the existing read-only monitoring/report lifecycle for a selected subset",()=>{
   const selected=eventPlanFacts([city[0]]);
   const effect=eventReadinessEffect.parse({
     startDate:date,endDate:date,eventIds:[a],summary:"Check event timing",
     expectedBusyHours:[],actions:[{area:"prep",action:"Review pastry prep",
       reason:"Verified local convention timetable"}],
     facts:selected,factsHash:effectHash(selected),
   });
   const proposal={
     id:"33333333-3333-4333-8333-333333333333",businessId:"cafe",
     ownerUserId:"owner",threadId:"thread",locale:"en" as const,
     capabilityId:eventReadinessCapabilityId,capabilityVersion:1,
     canonicalEffectPayload:effect,effectHash:effectHash(effect),
     monitorSpec:{durationDays:1,metricScope:"event_readiness:"+date},
     monitoringStartDate:null,status:"draft" as const,createdAt:"2026-11-03T00:00:00Z",
   } as LoopProposal;
   const monitored=selectEventObservations([proposal]);
   expect(monitored).toHaveLength(1);
   expect(monitored[0].monitoringStartDate).toBe(date);
   expect(monitored[0].status).toBe("committed");
   expect(monitored[0].canonicalEffectPayload).toEqual(effect);
   expect(readOnlyEventObservation({...proposal,status:"rejected"})).toBeNull();
   expect(proposal.status).toBe("draft"); // observer never approves or mutates the owner plan
 });
});
