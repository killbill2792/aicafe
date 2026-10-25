import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const fixtures=vi.hoisted(()=>({db:null as SupabaseClient|null,authorized:true}));
vi.mock("@/lib/pos/toast/client",async()=>{const {z}=await import("zod");return {GUID:z.uuid()};});
vi.mock("@/lib/pos/toast/ownerAccess",()=>({
 authorizeToastOwner:async()=>fixtures.authorized?fixtures.db:null
}));
import {GET} from "./status/route";
import {POST as firstAnswer} from "./first-import-check/route";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const n="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const s="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const iso=(i:number)=>new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);
type Row=Record<string,unknown>;
function day(date:string,guid:string):Row{
 return {restaurant_guid:guid,business_date:date,import_state:"imported",
  coverage_complete:true,recon_state:"matched",net_sales_cents:10000,
  toast_net_sales_cents:10000,delta_net_cents:0,order_count:5,last_error_category:null};
}
const north={restaurant_guid:n,verified_at:"2026-10-01T12:00:00Z",
 toast_time_zone:"America/Los_Angeles",toast_start_date:"2026-01-01"};
const south={...north,restaurant_guid:s,toast_start_date:"2026-06-01"};
function dbWith(mappings:Row[],days:Row[],flags:Row[]=[],runs:Row[]=[]){
 const rpc=vi.fn().mockResolvedValue({data:null,error:null});
 const tables:Record<string,Row[]>={
  toast_api_credentials:[{state:"verified",last_error_category:null}],
  toast_location_mappings:mappings,toast_sync_runs:runs,
  toast_day_status:days,toast_day_owner_flags:flags,
  toast_owner_attention_days_v:flags.map(f=>({business_date:f.business_date,restaurant_guid:f.restaurant_guid})),
  toast_owner_summary_entries:[],
  toast_analytics_credentials:[],
  toast_first_import_check:[],businesses:[{timezone:"America/Los_Angeles"}],
  toast_sync_health_v:mappings.map(()=>({last_good_sync_at:"2026-10-24T12:00:00Z",stale:false,warnings:{},days_with_unreadable_orders:0}))
 };
 const pages:Record<string,number>={};
 const db={
  from(table:string){
   const rows=tables[table]??[];
   const query={
    select(_fields:string){return query;},eq(_field:string,_value:unknown){return query;},
    is(_field:string,_value:unknown){return query;},
    order(_field:string,_options?:unknown){return query;},
    range(start:number,end:number){pages[table]=(pages[table]??0)+1;
     return Promise.resolve({data:rows.slice(start,end+1),error:null});},
    maybeSingle(){return Promise.resolve({data:rows[0]??null,error:null});},
    then(ok:(x:unknown)=>unknown,bad?:(x:unknown)=>unknown){
     return Promise.resolve({data:rows,error:null}).then(ok,bad);
    },
   };return query;
  },rpc
 };
 fixtures.db=db as unknown as SupabaseClient;
 return {pages,rpc};
}
beforeEach(()=>{vi.stubEnv("TOAST_SETUP_ENABLED","true");
 vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","false");fixtures.authorized=true;});
describe("owner Toast status — real multi-location histories",()=>{
 it("paginates more than 500 imported days and 1000 runs instead of hiding controls",async()=>{
  const days=Array.from({length:270},(_,i)=>[day(iso(i),n),day(iso(i),s)]).flat();
  const runs=Array.from({length:1007},(_,i)=>({id:`eeeeeeee-eeee-4eee-8eee-${String(i+1).padStart(12,"0")}`,
   kind:"backfill",state:"completed",days_done:1,days_total:1,
   resume_at:null,requested_from:iso(i%270),requested_to:iso(i%270)}));
  const f=dbWith([north,{...south,toast_start_date:"2026-01-01"}],days,[],runs);
  const result=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(result.status).toBe(200);
  const payload=await result.json();
  expect(payload.firstImportCheck).toBe("due");
  expect(payload.firstImportRows).toHaveLength(7);
  expect(payload.failedRuns).toBe(0);
  expect(f.pages.toast_day_status).toBeGreaterThan(2);
  expect(f.pages.toast_sync_runs).toBeGreaterThan(5);
 });
 it("uses the start date of each verified restaurant, not today's roster",async()=>{
  const days=[...Array.from({length:7},(_,i)=>day(iso(i),n)),
   day("2026-06-02",n)]; // second restaurant not imported yet
  dbWith([north,south],days);
  const response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(200);
  const status=await response.json();
  expect(status.firstImportCheck).toBe("due");
  expect(status.firstImportRows).toHaveLength(7);
  expect(status.firstImportRows.every((row:Row)=>row.oursCents===10000)).toBe(true);
 });
 it("keeps an active owner flag visible even without a day-status row",async()=>{
  dbWith([north],[],[{business_date:"2026-10-20",restaurant_guid:n,cleared_at:null}]);
  const response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(200);
  expect((await response.json()).needsLook).toMatchObject([{
   date:"2026-10-20",restaurantGuid:n,reason:"owner_flag",oursCents:null
  }]);
 });
 it("fails closed on invalid raw money instead of silently converting it to missing",async()=>{
  dbWith([north],[{...day(iso(0),n),net_sales_cents:"100.00"}]);
  const response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(503);
 });
 it("renders configured location even when closeout timezone has not been fetched",async()=>{
  dbWith([{...north,verified_at:null,toast_time_zone:null}],[]);
  const response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(200);
  const data=await response.json();
  expect(data.connection).toBe("needs_attention");
  expect(data.timeZone).toBe("America/Los_Angeles");
 });
 it("keeps setup visible but reports import disabled until the separate flag is on",async()=>{
  dbWith([north],[]);
  let response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(200);
  expect((await response.json()).importEnabled).toBe(false);
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(200);
  expect((await response.json()).importEnabled).toBe(true);
 });
 it("rejects a non-owner without exposing whether a Toast account exists",async()=>{
  fixtures.authorized=false;
  const response=await GET(new Request(`http://localhost/api/pos/toast/status?businessId=${b}`));
  expect(response.status).toBe(404);
 });
});
describe("first-import reply uses the identical history coverage rule",()=>{
 it("accepts seven dates before the second restaurant starts, past page one",async()=>{
  const base=Array.from({length:265},(_,i)=>day(iso(i),n));
  const f=dbWith([north,south],base);
  const res=await firstAnswer(new Request("http://localhost/api/pos/toast/first-import-check",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({businessId:b,answer:"something_off",flaggedDates:[iso(0)],note:"Different from register"})
  }));
  expect(res.status).toBe(200);
  expect(f.pages.toast_day_status).toBeGreaterThan(1);
  expect(f.rpc).toHaveBeenCalledWith("toast_answer_first_import_check",{
   p_business_id:b,p_answer:"something_off",p_days:[iso(0)],p_note:"Different from register"
  });
 });
});
