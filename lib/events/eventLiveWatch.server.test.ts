import {beforeEach,describe,expect,it,vi} from "vitest";
import {effectHash,monitorLoop} from "@/lib/ai/supervisor/loop/engine";
import {watchLiveEvents} from "./eventLiveWatch.server";

vi.mock("server-only",()=>({}));
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
const db={
  from(table:string){
    if(table==="businesses")return {
      select:()=>({eq:()=>({maybeSingle:async()=>({data:{
        timezone:"America/Los_Angeles",is_demo:false},error:null})})})};
    if(table==="locations")return {
      select:()=>({eq:()=>({limit:async()=>({data:[{open_hours:{
        sat:[["00:00","23:59"]]} }],error:null})})})};
    if(table==="supervisor_proposals"){
      const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,
        limit:async()=>({data:[{id:proposal.id,
          owner_user_id:proposal.ownerUserId,thread_id:proposal.threadId}],error:null})};
      return q;
    }
    throw Error("unrecognized table");
  },
};
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>db}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  SupabaseLoopRepository:class {load=vi.fn(async()=>({...proposal}));},
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
   vi.clearAllMocks();vi.useFakeTimers();
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
 it("does not monitor a future or past day",async()=>{
   expect(await watchLiveEvents(businessId,"2026-11-01")).toMatchObject({checked:0});
   expect(monitorLoop).not.toHaveBeenCalled();
 });
});
