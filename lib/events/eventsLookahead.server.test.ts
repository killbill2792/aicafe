import {describe,expect,it} from "vitest";
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {eventPlanFacts} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {pendingEventDays,matchingEventPreparation} from "./eventsLookahead.server";
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
 it("refreshes a multi-day event on its actual local day without rerunning the same-day assessment",()=>{
   const e=event({startDate:"2026-11-03",endDate:"2026-11-05"});
   const hash=effectHash(eventPlanFacts([e]));
   const plan={startDate:"2026-11-04",factsHash:hash,status:"approved"};
   const prior={startDate:"2026-11-04",factsHash:hash,sourceHash:"s",assessedOn:"2026-11-03"};
   expect(pendingEventDays([e],[plan],"2026-11-04","2026-11-04",[prior],"s"))
     .toEqual([{date:"2026-11-04",events:[e],hash,refresh:true}]);
   expect(pendingEventDays([e],[plan],"2026-11-04","2026-11-04",
     [{...prior,assessedOn:"2026-11-04"}],"s")).toEqual([]);
 });
 it("reuses only the same occurrence, verified facts, covered dates and unchanged action",()=>{
   const actions=[{area:"prep",action:"Prepare pastry stock",reason:"Initial evidence"}];
   const prior={proposalId:"p",threadId:"t",revision:1,status:"approved",eventIds:["event"],
     startDate:"2026-11-03",endDate:"2026-11-05",factsHash:"hash",actions,
     summary:"Plan",expectedBusyHours:[],reportStatus:null,report:null};
   const input={eventIds:["event"],startDate:"2026-11-04",endDate:"2026-11-04",
     actions:[{...actions[0],reason:"New observation, same action"}]};
   expect(matchingEventPreparation([prior],input,"hash")).toEqual(prior);
   expect(matchingEventPreparation([{...prior,status:"rejected"}],input,"hash")?.status).toBe("rejected");
   expect(matchingEventPreparation([prior],{...input,actions:[{area:"prep",action:"Increase pastry stock"}]},"hash")).toBeUndefined();
   expect(matchingEventPreparation([prior],input,"corrected")).toBeUndefined();
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
