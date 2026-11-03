import {describe,it,expect} from "vitest";
import {eventPlanFacts} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {eventAssessmentSourceHash,pendingEventDays} from "./eventsLookahead.server";
import type {CafeEvent,SavedEventTimeline} from "@/lib/data/cafeEvents.server";

const date="2026-11-04",id="11111111-1111-4111-8111-111111111111";
const event=(over:Partial<CafeEvent>={}):CafeEvent=>({
 id,name:"Convention near café",kind:"conference",startDate:date,endDate:date,
 startTime:"09:00",endTime:"16:00",venue:"Center",venueAddress:"1 Main St",
 areaLabel:null,sourceUrl:"https://city.example/convention",status:"found",
 foundAt:"2026-11-01T00:00:00Z",lastCheckedAt:"2026-11-01T00:00:00Z",...over,
});
const timeline=(over:Partial<SavedEventTimeline>={}):SavedEventTimeline=>({
 events:[event()],plans:[],cityCoverage:{status:"complete",researchedSourceWindows:5,
 successfulSourceWindows:5,failedSourceWindows:0,partialSourceWindows:0,
 unsearchedSourceWindows:0,lastCompletedAt:"2026-11-03T02:00:00Z"},
 neighborhood:[{placeId:"place-a",name:"Convention Center",kind:"convention",
 address:"1 Main St",sourceUrl:"https://city.example/center",
 calendarUrl:"https://city.example/calendar",visitorInfoUrl:null,
 visitorApproach:null,entrance:null,assessment:"possible",
 rationale:"One block away",checkedAt:"2026-11-02T02:00:00Z"}],
 ...over,
});

describe("same cron assessment outcome, saved in the existing operating_tasks inbox ledger",()=>{
 it("does not repeat a no-action conclusion for an unchanged city and café context",()=>{
   const t=timeline(),sourceHash=eventAssessmentSourceHash(t);
   const first=pendingEventDays(t.events,t.plans,date,date,[],sourceHash);
   expect(first).toHaveLength(1);
   expect(pendingEventDays(t.events,t.plans,date,date,
     [{startDate:date,factsHash:first[0].hash,sourceHash}],sourceHash)).toEqual([]);
 });
 it("does not rerun merely because research was checked again",()=>{
   const before=timeline(),after=timeline({cityCoverage:{...timeline().cityCoverage!,
     lastCompletedAt:"2026-11-04T10:00:00Z"},neighborhood:[
       {...timeline().neighborhood![0],checkedAt:"2026-11-04T10:00:00Z"},
     ]});
   expect(eventAssessmentSourceHash(before)).toBe(eventAssessmentSourceHash(after));
 });
 it("reconsiders new source coverage or a newly confirmed location, not weak guesses",()=>{
   const old=timeline(),sourceHash=eventAssessmentSourceHash(old);
   const hash=effectHash(eventPlanFacts(old.events));
   const prior=[{startDate:date,factsHash:hash,sourceHash}];
   const newCoverage=timeline({cityCoverage:{...old.cityCoverage!,status:"partial",
     partialSourceWindows:1,successfulSourceWindows:4}});
   expect(pendingEventDays(newCoverage.events,[],date,date,prior,
     eventAssessmentSourceHash(newCoverage))).toHaveLength(1);
   const enriched=event({venueAddress:"2 Main St"});
   expect(pendingEventDays([enriched],[],date,date,prior,sourceHash)).toHaveLength(1);
 });
 it("does not invent relevance for a cancelled event or replace an approved/declined choice",()=>{
   const events=[event(),event({id:"22222222-2222-4222-8222-222222222222",
     name:"Cancelled concert",status:"cancelled"})];
   const hash=effectHash(eventPlanFacts([events[0]]));
   const pending=pendingEventDays(events,[],date,date);
   expect(pending).toHaveLength(1);
   expect(pending[0].events).toEqual([events[0]]);
   for(const status of ["approved","rejected","committed","manual_confirmed"]){
     expect(pendingEventDays(events,[{startDate:date,factsHash:"stale",status}],
       date,date)).toEqual([]);
   }
   expect(pending[0].hash).toBe(hash);
 });
 it("allows a new draft on changed facts while same-hash drafts remain idempotent",()=>{
   const original=event(),hash=effectHash(eventPlanFacts([original]));
   expect(pendingEventDays([original],[{startDate:date,factsHash:hash,status:"draft"}],
     date,date)).toEqual([]);
   expect(pendingEventDays([event({startTime:"10:00"})],
     [{startDate:date,factsHash:hash,status:"draft"}],date,date)).toHaveLength(1);
 });
});
