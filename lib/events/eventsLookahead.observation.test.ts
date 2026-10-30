import {describe,expect,it,vi,beforeEach} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {effectHash,monitorLoop} from "@/lib/ai/supervisor/loop/engine";
import {authorizedScheduledEventScope,eventReadinessCapabilityId}
  from "@/lib/ai/supervisor/loop/eventReadiness.server";
import {reportSavedEventDays} from "./eventsLookahead.server";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/supervisor/loop/engine",async importOriginal=>{
  const real=await importOriginal<typeof import("@/lib/ai/supervisor/loop/engine")>();
  return {...real,monitorLoop:vi.fn()};
});
vi.mock("@/lib/ai/supervisor/loop/eventReadiness.server",async importOriginal=>{
  const real=await importOriginal<typeof import("@/lib/ai/supervisor/loop/eventReadiness.server")>();
  return {...real,authorizedScheduledEventScope:vi.fn(async scope=>scope)};
});
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  stableMessageId:vi.fn(),SupabaseLoopRepository:class {},
}));
const businessId="11111111-1111-4111-8111-111111111111";
const ownerId="22222222-2222-4222-8222-222222222222";
const effect=(day:string)=>({
  startDate:day,endDate:day,eventIds:["33333333-3333-4333-8333-333333333333"],
  summary:"Prepare for nearby parade",expectedBusyHours:[],
  actions:[{area:"promo",action:"Consider a seasonal combo",reason:"There is a parade"}],
  facts:[{id:"33333333-3333-4333-8333-333333333333",name:"Parade",
    kind:"parade",startDate:day,endDate:day,venue:null,areaLabel:null,sourceUrl:null}],
  factsHash:"a".repeat(64),
});
function row(day:string,status="draft"){
  const plan=effect(day);
  return {id:"44444444-4444-4444-8444-444444444444",business_id:businessId,
    owner_user_id:ownerId,thread_id:"55555555-5555-4555-8555-555555555555",
    capability_id:eventReadinessCapabilityId,capability_version:1,
    canonical_effect_payload:plan,effect_hash:effectHash(plan),baseline:{},
    monitor_spec:{durationDays:1,metricScope:"event"},status,revision:0,
    monitoring_start_date:null,locale:"en",created_at:"2026-10-30T00:00:00Z"};
}
const fake=(rows:ReturnType<typeof row>[])=>({
  from(table:string){
    if(table==="supervisor_monitor_samples")return {
      select:()=>({eq:()=>({in:()=>({limit:async()=>({data:[],error:null})})})})};
    if(table!=="supervisor_proposals")throw Error("unexpected table "+table);
    const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,
      limit:async()=>({data:rows,error:null})};
    return q;
  }
}) as unknown as SupabaseClient;
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(monitorLoop).mockResolvedValue({
    status:"complete",result:{},recommendation:"adjust",source:"toast"} as never);
});
describe("automatic café-local final event observation",()=>{
  it("does not monitor tomorrow's saved event",async()=>{
    expect(await reportSavedEventDays(fake([row("2026-10-31")]),
      businessId,ownerId,"2026-10-30")).toEqual({checked:0,reported:0,failed:0});
    expect(monitorLoop).not.toHaveBeenCalled();
  });
  it("reports Oct 31 on Nov 1 without an approval or commit",async()=>{
    const draft=row("2026-10-31");
    expect(await reportSavedEventDays(fake([draft]),businessId,ownerId,"2026-11-01"))
      .toEqual({checked:1,reported:1,failed:0});
    expect(authorizedScheduledEventScope).toHaveBeenCalledWith(expect.objectContaining({
      businessId,ownerUserId:ownerId}));
    const args=vi.mocked(monitorLoop).mock.calls[0];
    expect(args[3]).toMatchObject({
      id:draft.id,status:"committed",monitoringStartDate:"2026-10-31"});
    expect(args[4]).toBe("2026-10-31");
    expect(draft).toMatchObject({status:"draft",monitoring_start_date:null});
  });
  it("retries the exact closed day after a late POS import, never a future day",async()=>{
    const result=await reportSavedEventDays(fake([row("2026-10-31")]),
      businessId,ownerId,"2026-11-02");
    expect(result).toEqual({checked:1,reported:1,failed:0});
    expect(monitorLoop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(monitorLoop).mock.calls[0][4]).toBe("2026-10-31");
  });
  it("does not watch rejected proposals or create a report from them",async()=>{
    expect(await reportSavedEventDays(fake([row("2026-10-31","rejected")]),
      businessId,ownerId,"2026-11-01")).toEqual({checked:0,reported:0,failed:0});
    expect(monitorLoop).not.toHaveBeenCalled();
  });
});
