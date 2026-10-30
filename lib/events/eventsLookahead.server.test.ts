import {describe,expect,it} from "vitest";
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {eventPlanFacts} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {pendingEventDays} from "./eventsLookahead.server";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";

const event=(values:Partial<CafeEvent>={}):CafeEvent=>({
 id:"11111111-1111-4111-8111-111111111111",name:"Downtown parade",
 kind:"parade",startDate:"2026-11-03",endDate:"2026-11-03",
 startTime:"11:00",endTime:"13:00",venue:"Square",venueAddress:"1 Main St",
 areaLabel:"Downtown",sourceUrl:"https://city.example/parade",
 status:"found",foundAt:"2026-10-29T00:00:00Z",lastCheckedAt:"2026-10-29T00:00:00Z",
 ...values,
});
describe("saved event readiness plan-once selection",()=>{
 it("creates a plan only for days that have saved and confirmed events",()=>{
   const day=event();
   expect(pendingEventDays([day],[],"2026-11-02","2026-11-15")).toEqual([
     {date:"2026-11-03",events:[day],hash:effectHash(eventPlanFacts([day]))},
   ]);
   expect(pendingEventDays([event({status:"cancelled"})],[],
     "2026-11-02","2026-11-15")).toEqual([]);
 });
 it("never repeats the existing fact hash after a refresh",()=>{
   const day=event(),hash=effectHash(eventPlanFacts([day]));
   expect(pendingEventDays([event({lastCheckedAt:"2026-10-30T00:00:00Z"})],
     [{startDate:"2026-11-03",factsHash:hash}],"2026-11-02","2026-11-15"))
      .toEqual([]);
 });
 it("requires a new proposal when a confirmed venue or time changes",()=>{
   const before=event(),after=event({startTime:"12:00",venueAddress:"2 Main St"});
   const pending=pendingEventDays([after],[{startDate:"2026-11-03",
     factsHash:effectHash(eventPlanFacts([before]))}],"2026-11-02","2026-11-15");
   expect(pending).toHaveLength(1);
   expect(pending[0].hash).not.toBe(effectHash(eventPlanFacts([before])));
 });
 it("groups multiple confirmed events on one day, never inventing business impact",()=>{
   const first=event(),other=event({
     id:"22222222-2222-4222-8222-222222222222",name:"Market",
     sourceUrl:"https://city.example/market",
   });
   expect(pendingEventDays([first,other],[],"2026-11-03","2026-11-03")[0]
      .events).toHaveLength(2);
 });
});
