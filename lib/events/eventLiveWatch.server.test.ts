import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
import {effectHash,monitorLoop} from "@/lib/ai/supervisor/loop/engine";
import {watchLiveEvents} from "./eventLiveWatch.server";
import {readCanonicalCafeEvents} from "@/lib/data/cafeEvents.server";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/cafeEvents.server",async importOriginal=>({...await importOriginal<typeof import("@/lib/data/cafeEvents.server")>(),readCanonicalCafeEvents:vi.fn(async()=>[])}));
const day="2026-10-31";
const businessId="11111111-1111-4111-8111-111111111111";
const effect={startDate:day,endDate:day,
  eventIds:["33333333-3333-4333-8333-333333333333"],
  summary:"Prepare for the parade",expectedBusyHours:[],
  actions:[{area:"prep",action:"Consider more supplies",reason:"The parade is nearby"}],
  facts:[{id:"33333333-3333-4333-8333-333333333333",name:"Parade",
    kind:"parade",startDate:day,endDate:day,venue:null,areaLabel:null,sourceUrl:null}],
  factsHash:"a".repeat(64)};
const proposal={id:"44444444-4444-4444-8444-444444444444",
  businessId,ownerUserId:"22222222-2222-4222-8222-222222222222",
  threadId:"55555555-5555-4555-8555-555555555555",
  capabilityId:"alex.event_readiness.v1",capabilityVersion:1,
  canonicalEffectPayload:effect,effectHash:effectHash(effect),baseline:{},
  monitorSpec:{durationDays:1,metricScope:"event"},revision:0,locale:"en",
  createdAt:"2026-10-30T00:00:00Z",monitoringStartDate:null,status:"draft"};
const savedEvent:CafeEvent={...effect.facts[0],startTime:null,endTime:null,venueAddress:null,status:"found",foundAt:"",lastCheckedAt:""};
let available=[proposal];
const errors={business:false,hours:false,missingTimezone:false};
const db={
  rpc:async()=>({data:true,error:null}),
  from(table:string){
    if(table==="businesses")return {
      select:()=>({eq:()=>({maybeSingle:async()=>({data:{
        timezone:errors.missingTimezone?null:"America/Los_Angeles",is_demo:false},
        error:errors.business?new Error("read failed"):null})})})};
    if(table==="locations")return {
      select:()=>({eq:()=>({limit:async()=>({data:[{open_hours:{
        sat:[["00:00","23:59"]]} }],
        error:errors.hours?new Error("hours unavailable"):null})})})};
    if(table==="supervisor_monitor_samples")return {
      select:()=>({eq:()=>({in:()=>({limit:async()=>({data:[],error:null})})})})};
    if(table==="supervisor_proposals"){
      const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,
        limit:async()=>({data:available.map(p=>({id:p.id,
          owner_user_id:p.ownerUserId,thread_id:p.threadId})),error:null})};
      return q;
    }
    throw Error("unrecognized table");
  },
};
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>db}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  SupabaseLoopRepository:class {load=vi.fn(async(_scope:unknown,id:string)=>({...available.find(p=>p.id===id)!}));},
}));
vi.mock("@/lib/ai/supervisor/loop/engine",async importOriginal=>{
  const real=await importOriginal<typeof import("@/lib/ai/supervisor/loop/engine")>();
  return {...real,monitorLoop:vi.fn(async()=>({status:"in_progress"}))};
});
vi.mock("@/lib/ai/supervisor/loop/eventReadiness.server",async importOriginal=>{
  const real=await importOriginal<typeof import("@/lib/ai/supervisor/loop/eventReadiness.server")>();
  return {...real,authorizedScheduledEventScope:vi.fn(async s=>s)};
});
describe("live event watch is read-only",()=>{
 beforeEach(()=>{
   vi.clearAllMocks();vi.useFakeTimers();available=[proposal];
   vi.mocked(readCanonicalCafeEvents).mockResolvedValue([savedEvent]);
   errors.business=false;errors.hours=false;errors.missingTimezone=false;
   vi.setSystemTime(new Date("2026-10-31T16:00:00Z")); // 09:00 Pacific
 });
 afterEach(()=>vi.useRealTimers());
 it("watches a draft on the event day, never requiring approveLoop/commitLoop",async()=>{
   expect(await watchLiveEvents(businessId,day)).toEqual({
     checked:1,updated:1,failed:0});
   expect(monitorLoop).toHaveBeenCalledWith(
     expect.objectContaining({businessId}),expect.anything(),expect.anything(),
     expect.objectContaining({status:"committed",monitoringStartDate:day}),
     day,true,true,true);
   expect(proposal).toMatchObject({status:"draft",monitoringStartDate:null});
 });
 it("monitors the other confirmed occurrence when the prior event is cancelled",async()=>{
   const newId="77777777-7777-4777-8777-777777777777";
   const nextEffect={...effect,eventIds:[newId],facts:[{...effect.facts[0],id:newId}]};
   const next={...proposal,id:"88888888-8888-4888-8888-888888888888",
     canonicalEffectPayload:nextEffect,effectHash:effectHash(nextEffect)};
   available=[proposal,next];
   vi.mocked(readCanonicalCafeEvents).mockResolvedValue([{...savedEvent,status:"cancelled"},{...savedEvent,id:newId}]);
   expect(await watchLiveEvents(businessId,day)).toEqual({checked:1,updated:1,failed:0});
   expect(monitorLoop).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.anything(),
     expect.objectContaining({id:next.id}),day,true,true,true);
 });
 it("does not monitor a future or past day",async()=>{
   expect(await watchLiveEvents(businessId,"2026-11-01")).toMatchObject({checked:0});
   expect(monitorLoop).not.toHaveBeenCalled();
 });
 it("reports a failed tenant or opening-hours read rather than silently skipping",async()=>{
   errors.business=true;
   expect(await watchLiveEvents(businessId,day)).toEqual({
     checked:0,updated:0,failed:1,
   });
   errors.business=false;errors.missingTimezone=true;
   expect(await watchLiveEvents(businessId,day)).toEqual({
     checked:0,updated:0,failed:1,
   });
   errors.missingTimezone=false;errors.hours=true;
   expect(await watchLiveEvents(businessId,day)).toEqual({
     checked:0,updated:0,failed:1,
   });
   expect(monitorLoop).not.toHaveBeenCalled();
 });

});
