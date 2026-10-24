import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
const m=vi.hoisted(()=>({request:vi.fn(),roster:vi.fn(),catalog:vi.fn(),labor:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./client",async()=>{
 const {z}=await import("zod");
 class ToastApiError extends Error{constructor(public category:string){super(category);}}
 return {ToastApiError,GUID:z.uuid(),createToastClient:()=>({request:m.request})};
});
vi.mock("./operationalStaging",()=>({
 stageToastCatalog:m.catalog,stageToastRoster:m.roster
}));
vi.mock("./laborSync",()=>({syncToastLaborReadOnly:m.labor}));
import {syncToastOptionalSources} from "./optionalSync";
import {ToastApiError} from "./client";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const location="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const scope={business_id:business,restaurant_guid:restaurant,location_id:location,
 toast_time_zone:"America/Los_Angeles",closeout_hour:4};
const now=new Date("2026-10-23T19:00:00-07:00");
function mockDB(scopes:Record<string,boolean>){
 const writes:Array<Record<string,unknown>>=[];
 const db={
  from(table:string){
   const q={
    select(_columns:string){return q;},eq(_key:string,_value:unknown){return q;},
    async maybeSingle(){return {data:table==="toast_api_credentials"
     ?{scopes_available:scopes}:null,error:null};},
    async upsert(value:Record<string,unknown>){writes.push(value);return {error:null};}
   };return q;
  }
 };
 return {db:db as unknown as SupabaseClient,writes};
}
beforeEach(()=>{
 Object.values(m).forEach(fn=>fn.mockReset());
 m.roster.mockResolvedValue({staged:0});
 m.catalog.mockResolvedValue({staged:0});
 m.labor.mockResolvedValue({staged:0});
 m.request.mockImplementation(async (path:string)=>{
  if(path.includes("/menus/v2/metadata"))
   return {restaurantGuid:restaurant,lastUpdated:"2026-10-23T00:00:00Z"};
  return [];
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
  expect(m.labor).toHaveBeenCalledTimes(2);
  expect(m.request.mock.calls.map(c=>String(c[0]))).toEqual(
   expect.arrayContaining(["/labor/v1/jobs","/config/v2/voidReasons"]));
  expect(f.writes.some(w=>w.labor_local_day==="2026-10-23")).toBe(true);
 });
 it("missing optional scopes safely skip all provider calls",async()=>{
  const f=mockDB({menus:false,labor:false,config:false});
  await expect(syncToastOptionalSources(f.db,scope,now,Date.now()+20000))
   .resolves.toMatchObject({menu:"scope_missing",labor:"scope_missing"});
  expect(m.request).not.toHaveBeenCalled();
  expect(m.roster).not.toHaveBeenCalled();
  expect(m.labor).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
 });
});
