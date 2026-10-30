import {describe,expect,it} from "vitest";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import {credibleEventEvidence,eventVerificationDue,importantVerificationQueue,
  verifiedEventChange,type EventEvidence} from "./eventVerification";

const event=(status:CafeEvent["status"]="found"):CafeEvent=>({
 id:"00000000-0000-4000-8000-000000000011",name:"Saturday Parade",kind:"parade",
 startDate:"2026-11-06",endDate:"2026-11-06",startTime:"11:00",endTime:"13:00",
 venue:"Main Street",venueAddress:null,areaLabel:null,
 sourceUrl:"https://city.example/events/parade",status,
 foundAt:"2026-10-28T00:00:00Z",lastCheckedAt:"2026-10-28T00:00:00Z",
});
const evidence=(verdict:EventEvidence["verdict"],extra:Partial<EventEvidence>={}):EventEvidence=>({
 verdict,sourceUrl:"https://city.example/events/parade",
 statement:"Organizer confirms the parade's status.",newDate:null,newVenue:null,...extra,
});
const cited=["https://city.example/events/parade"];
const at="2026-11-01T12:00:00Z";

describe("early event verification guardrails",()=>{
 it("checks a planned event five days before purchases could be made, not just the day before",()=>{
   const now=new Date(at);
   const plan={startDate:"2026-11-06",endDate:"2026-11-06",status:"committed"};
   expect(importantVerificationQueue([event()], [plan],"2026-11-01",now)).toEqual([event()]);
   expect(eventVerificationDue({...event(),lastAttemptedAt:"2026-10-30T11:00:00Z"},
     "2026-11-01",now)).toBe(false);
   expect(eventVerificationDue({...event(),lastAttemptedAt:"2026-10-28T00:00:00Z"},
     "2026-11-01",now)).toBe(true);
 });
 it("needs a saved plan and known sourced event, and never verifies a holiday",()=>{
   expect(importantVerificationQueue([event()],[],"2026-11-01",new Date(at))).toEqual([]);
   expect(importantVerificationQueue([{...event(),kind:"holiday",sourceUrl:null}],
     [{startDate:"2026-11-06",endDate:"2026-11-06",status:"draft"}],
     "2026-11-01",new Date(at))).toEqual([]);
 });
 it("records an explicit cited cancellation without removing the original event/plan",()=>{
   const change=verifiedEventChange(event(),evidence("cancelled"),cited,at);
   expect(change).toMatchObject({id:event().id,previousStatus:"found",status:"cancelled",
     sourceUrl:cited[0],verifiedAt:at});
   expect(event().startDate).toBe("2026-11-06");
 });
 it("keeps original dates while recording postponement, venue change and reinstatement",()=>{
   expect(verifiedEventChange(event(),evidence("postponed",
     {newDate:"2026-11-13"}),cited,at)).toMatchObject({
       status:"moved",newDate:"2026-11-13",previousStatus:"found"});
   expect(verifiedEventChange(event(),evidence("venue_changed",
     {newVenue:"Town Hall"}),cited,at)?.newVenue).toBe("Town Hall");
   expect(verifiedEventChange(event("cancelled"),evidence("reinstated"),cited,at))
     .toMatchObject({status:"found",previousStatus:"cancelled"});
 });
 it("cannot cancel from omission, unsupported claims, conflicting sources or foreign links",()=>{
   expect(verifiedEventChange(event(),evidence("cancelled"),[],at)).toBeNull();
   expect(verifiedEventChange(event(),evidence("conflicting"),cited,at)).toBeNull();
   expect(verifiedEventChange(event(),evidence("unverified"),cited,at)).toBeNull();
   expect(verifiedEventChange(event(),evidence("cancelled",
     {sourceUrl:"https://unrelated.example/change"}),["https://unrelated.example/change"],at))
     .toBeNull();
   expect(credibleEventEvidence(event(),evidence("cancelled",{statement:""}),cited)).toBe(false);
   expect(verifiedEventChange(event("cancelled"),evidence("confirmed"),cited,at)).toBeNull();
 });
});
