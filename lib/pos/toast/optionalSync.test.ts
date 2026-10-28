import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
const m=vi.hoisted(()=>({request:vi.fn(),roster:vi.fn(),catalog:vi.fn(),labor:vi.fn(),attendance:vi.fn(),staged:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./client",async()=>{
 const {z}=await import("zod");
 class ToastApiError extends Error{constructor(public category:string){super(category);}}
 return {ToastApiError,GUID:z.uuid(),createToastClient:()=>({request:m.request})};
});
vi.mock("./operationalCopy",()=>({
 copyToastPublishedMenu:m.catalog,copyToastStaff:m.roster,copyToastAttendance:m.attendance,
 importStagedToastAttendance:m.staged
}));
vi.mock("./laborSync",()=>({syncToastLaborReadOnly:m.labor}));
import {syncToastOptionalSources,ensureToastFirstCatalog} from "./optionalSync";
import {ToastApiError} from "./client";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const location="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const scope={business_id:business,restaurant_guid:restaurant,location_id:location,
 toast_time_zone:"America/Los_Angeles",closeout_hour:4};
const now=new Date("2026-10-23T19:00:00-07:00");
function mockDB(scopes:Record<string,boolean>,alreadyCopied=false,stale=false,legacyChecked=false){
 let lastMenu=legacyChecked?"2026-10-23T00:00:00Z":
  alreadyCopied?"2026-10-22T00:00:00Z":null;
 const writes:Array<Record<string,unknown>>=[];
 const rpcCalls:string[]=[];
 let copyAt=alreadyCopied?"2026-10-22T00:00:00Z":null;
 let rosterAt=alreadyCopied?"2026-10-22T00:00:00Z":null;
 let attendanceAt=alreadyCopied?"2026-10-22T00:00:00Z":null;
 const db={
  async rpc(name:string){rpcCalls.push(name);return {error:null,data:0};},
  from(table:string){
   const q={
    select(_columns:string){return q;},eq(_key:string,_value:unknown){return q;},
    async maybeSingle(){return {data:table==="toast_api_credentials"
     ?{scopes_available:scopes}:table==="toast_optional_sync_state"
      ?{menu_last_updated:lastMenu,menu_copied_at:copyAt,
        roster_copied_at:rosterAt,attendance_copied_at:attendanceAt,
        menu_checked_local_day:stale?"2026-10-23":null,
        roster_local_day:stale?"2026-10-23":null,
        labor_local_day:stale?"2026-10-23":null}:null,error:null};},
    async upsert(value:Record<string,unknown>){
      writes.push(value);
      if(typeof value.menu_last_updated==="string")lastMenu=value.menu_last_updated;
      if(typeof value.menu_copied_at==="string")copyAt=value.menu_copied_at;
      if(typeof value.roster_copied_at==="string")rosterAt=value.roster_copied_at;
      if(typeof value.attendance_copied_at==="string")attendanceAt=value.attendance_copied_at;
      return {error:null};}
   };return q;
  }
 };
 return {db:db as unknown as SupabaseClient,writes,rpcCalls};
}
beforeEach(()=>{
 Object.values(m).forEach(fn=>fn.mockReset());
 m.roster.mockResolvedValue({staged:0});
 m.catalog.mockResolvedValue({staged:0});
 m.labor.mockResolvedValue({staged:0});
 m.attendance.mockResolvedValue({changed:0,affectedDates:[]});
 m.staged.mockResolvedValue({changed:0,affectedDates:[]});
 m.request.mockImplementation(async (path:string)=>{
  if(path.includes("/menus/v2/metadata"))
   return {restaurantGuid:restaurant,lastUpdated:"2026-10-23T00:00:00Z"};
  return [];
 });
});
describe("first-time Toast catalog before sales",()=>{
 it("imports the first menu once and stamps only after copy succeeds",async()=>{
   const f=mockDB({menus:true});
   const deadline=Date.now()+20000;
   expect(await ensureToastFirstCatalog(f.db,scope,now,deadline)).toBe(true);
   expect(m.catalog).toHaveBeenCalledTimes(1);
   expect(f.writes).toContainEqual(expect.objectContaining({
     menu_last_updated:"2026-10-23T00:00:00Z",
     menu_checked_local_day:"2026-10-23",
     menu_copied_at:expect.any(String),
   }));
   expect(await ensureToastFirstCatalog(f.db,scope,now,deadline)).toBe(false);
   expect(m.catalog).toHaveBeenCalledTimes(1);
 });
 it("never performs initial menu copy on already stamped or denied locations",async()=>{
   const copied=mockDB({menus:true},true);
   const denied=mockDB({menus:false});
   expect(await ensureToastFirstCatalog(copied.db,scope,now,Date.now()+20000)).toBe(false);
   expect(await ensureToastFirstCatalog(denied.db,scope,now,Date.now()+20000)).toBe(false);
   expect(m.catalog).not.toHaveBeenCalled();
 });
 it("copies when a legacy menu timestamp exists but no canonical copy stamp",async()=>{
   const f=mockDB({menus:true},false,true,true);
   await ensureToastFirstCatalog(f.db,scope,now,Date.now()+20000);
   expect(m.catalog).toHaveBeenCalledTimes(1);
   expect(f.writes.some(w=>typeof w.menu_copied_at==="string")).toBe(true);
 });
 it("does not stamp success after a failed catalog import",async()=>{
   const f=mockDB({menus:true});
   m.catalog.mockRejectedValueOnce(new ToastApiError("invalid_response"));
   await expect(ensureToastFirstCatalog(f.db,scope,now,Date.now()+20000))
     .rejects.toMatchObject({category:"invalid_response"});
   expect(f.writes).toEqual([]);
 });
});

describe("independent optional Toast source phases",()=>{
 it("a malformed menu response records the failure but does not block roster, labor, jobs or reasons",async()=>{
  const f=mockDB({menus:true,labor:true,config:true});
  m.request.mockImplementation(async(path:string)=>{
   if(path.includes("/menus/v2/metadata"))throw new ToastApiError("invalid_response");
   return [];
  });
  await expect(syncToastOptionalSources(f.db,scope,now,Date.now()+20000))
   .rejects.toMatchObject({category:"invalid_response"});
  expect(m.roster).toHaveBeenCalledTimes(1);
  expect(m.attendance).toHaveBeenCalledTimes(2);
  expect(m.labor).toHaveBeenCalledTimes(1); // scheduled shifts remain separate from paid hours
  expect(m.request.mock.calls.map(c=>String(c[0]))).toEqual(
   expect.arrayContaining(["/labor/v1/jobs","/config/v2/voidReasons"]));
  expect(f.writes.some(w=>w.labor_local_day==="2026-10-23")).toBe(true);
 });
 it("copies menu, staff and attendance with same-day legacy stamps",async()=>{
  const f=mockDB({menus:true,labor:true,config:false},false,true,true);
  await syncToastOptionalSources(f.db,scope,now,Date.now()+20000);
  expect(m.catalog).toHaveBeenCalledTimes(1);
  expect(m.roster).toHaveBeenCalledTimes(1);
  expect(m.attendance).toHaveBeenCalledTimes(2);
  expect(m.staged).toHaveBeenCalledTimes(1);
  expect(m.staged.mock.invocationCallOrder[0]).toBeGreaterThan(
   m.roster.mock.invocationCallOrder[0]);
  expect(f.writes).toEqual(expect.arrayContaining([
   expect.objectContaining({menu_copied_at:expect.any(String)}),
   expect.objectContaining({roster_copied_at:expect.any(String)}),
   expect.objectContaining({attendance_copied_at:expect.any(String)})
  ]));
  expect(f.rpcCalls).toContain("toast_resolve_linked_timecard_reviews");
  expect(f.rpcCalls).toContain("toast_queue_attendance_repair");
  await syncToastOptionalSources(f.db,scope,now,Date.now()+20000);
  expect(m.catalog).toHaveBeenCalledTimes(1);
  expect(m.roster).toHaveBeenCalledTimes(1);
  expect(m.attendance).toHaveBeenCalledTimes(2);
 });
 it("replays staged attendance before fetching, even when Toast changed nothing",async()=>{
  const f=mockDB({menus:false,labor:true,config:false},false,true);
  m.attendance.mockRejectedValueOnce(new ToastApiError("unavailable"));
  await expect(syncToastOptionalSources(f.db,scope,now,Date.now()+20000))
   .rejects.toMatchObject({category:"unavailable"});
  expect(m.staged).toHaveBeenCalledTimes(1);
  expect(f.rpcCalls).toContain("toast_resolve_linked_timecard_reviews");
  expect(f.writes.some(w=>w.attendance_copied_at)).toBe(false);
 });
 it("does not stamp attendance after failed canonical import",async()=>{
  const f=mockDB({menus:false,labor:true,config:false},false,true);
  m.attendance.mockRejectedValueOnce(new ToastApiError("unavailable"));
  await expect(syncToastOptionalSources(f.db,scope,now,Date.now()+20000))
    .rejects.toMatchObject({category:"unavailable"});
  expect(f.writes.some(w=>w.attendance_copied_at)).toBe(false);
 });
 it("missing optional scopes safely skip all provider calls",async()=>{
  const f=mockDB({menus:false,labor:false,config:false});
  await expect(syncToastOptionalSources(f.db,scope,now,Date.now()+20000))
   .resolves.toMatchObject({menu:"scope_missing",labor:"scope_missing"});
  expect(m.request).not.toHaveBeenCalled();
  expect(m.roster).not.toHaveBeenCalled();
  expect(m.labor).not.toHaveBeenCalled();
  expect(m.attendance).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
 });
});
