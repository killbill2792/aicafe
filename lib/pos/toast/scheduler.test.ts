import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

const m=vi.hoisted(()=>({importDay:vi.fn(),reconcile:vi.fn(),optional:vi.fn(),
 refresh:vi.fn(),costs:vi.fn(),request:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./dayImport",()=>({importToastBusinessDay:m.importDay}));
vi.mock("./reconcile",()=>({reconcileToastDays:m.reconcile}));
vi.mock("./optionalSync",()=>({syncToastOptionalSources:m.optional}));
vi.mock("./restaurantInfo",()=>({refreshToastRestaurantInfo:m.refresh}));
vi.mock("./rollupRetries",()=>({retryToastRollupRefreshes:m.costs}));
vi.mock("./client",()=>{
 class ToastApiError extends Error{
  constructor(public category:string){super(category);}
 }
 return {ToastApiError,createToastClient:()=>({request:m.request}),
  toToastTimestamp:(d:Date)=>d.toISOString()};
});
import {runToastSyncTick} from "./scheduler";
import {ToastApiError} from "./client";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const g="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const l="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now=new Date("2026-10-23T19:00:00-07:00");
const d="2026-10-22";
type Run={id:string;kind:string;state:string;requested_from:string;requested_to:string;
 days_done:number;days_total:number;cursor:Record<string,unknown>;resume_at:string|null};
function makeDB(){
 const mapping={business_id:b,restaurant_guid:g,location_id:l,
  toast_time_zone:"America/Los_Angeles",closeout_hour:4,
  verified_at:now.toISOString(),info_refreshed_at:now.toISOString()};
 const calls:string[]=[];
 const imports:string[]=[];
 const runs:Run[]=[];
 const status=new Set<string>();
 let backfillQueued=false;
 let scanDay:string|null=null;
 let claim=true;
 const resolve=(table:string,filters:Record<string,unknown>)=>{
  if(table==="toast_location_mappings")return [mapping];
  if(table==="toast_day_status"){
   const day=String(filters.business_date);
   return status.has(day)?[{import_state:"imported"}]:[];
  }
  if(table==="toast_repull_scan_state")
   return scanDay?[{last_local_day:scanDay}]:[];
  if(table==="toast_sync_runs"){
   if(filters.kind==="backfill" && !filters.state)
    return backfillQueued?[{id:"backfill-placeholder"}]:[];
   return runs.filter(r=>Object.entries(filters).every(([k,v])=>r[k as keyof Run]===v));
  }
  return [];
 };
 const db={
  from(table:string){
   const filters:Record<string,unknown>={};
   const q={
    select(_x:string){return q;},eq(k:string,v:unknown){filters[k]=v;return q;},
    not(_k:string,_op:string,_val:unknown){return q;},
    in(_k:string,_vals:unknown[]){return q;},
    order(_k:string){return q;},limit(_n:number){return q;},
    async maybeSingle(){return {data:resolve(table,filters)[0]??null,error:null};},
    async single(){return {data:resolve(table,filters)[0]??null,error:null};},
    async upsert(_row:unknown){calls.push("log_error");return {error:null};},
    then(yes:(v:unknown)=>unknown, no?:((e:unknown)=>unknown)){
     return Promise.resolve({data:resolve(table,filters),error:null}).then(yes,no);
    }
   };
   return q;
  },
  async rpc(name:string,args:Record<string,unknown>={}){
   calls.push(name);
   if(name==="toast_acquire_lease")return {data:claim?"lease-1":null,error:null};
   if(name==="toast_queue_daily"){
    if(!runs.some(r=>r.kind==="daily"&&r.requested_from===args.p_date))
     runs.push({id:"daily",kind:"daily",requested_from:String(args.p_date),
      requested_to:String(args.p_date),state:"queued",days_done:0,days_total:1,cursor:{},resume_at:null});
   }else if(name==="toast_queue_backfill")backfillQueued=true;
   else if(name==="toast_commit_repull_scan_window"){
    scanDay=String(args.p_local_day);
    for(const date of args.p_days as string[]){
     if(!runs.some(r=>r.kind==="repull_modified"&&r.requested_from===date))
      runs.push({id:"repull-"+date,kind:"repull_modified",state:"queued",
       requested_from:date,requested_to:date,days_done:0,days_total:1,cursor:{},resume_at:null});
    }
   }
   return {data:true,error:null};
  }
 };
 m.importDay.mockImplementation(async (_db:unknown,p:{runId:string;businessDate:string})=>{
  imports.push(p.businessDate);
  const run=runs.find(r=>r.id===p.runId)!;
  run.days_done++;run.state="completed";run.cursor={};
  status.add(p.businessDate);
  return {costsPending:false};
 });
 return {db:db as unknown as SupabaseClient,calls,imports,runs,status,
  setLease(v:boolean){claim=v;},get backfillQueued(){return backfillQueued;}};
}
beforeEach(()=>{
 vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
 for(const fn of Object.values(m))fn.mockReset();
 m.request.mockResolvedValue([]);
 m.optional.mockResolvedValue({menu:"skipped",labor:"skipped"});
 m.costs.mockResolvedValue({processed:0,deferred:0});
 m.reconcile.mockResolvedValue(0);
 m.refresh.mockResolvedValue(null);
});
describe("leased Toast cron phases (spec C1, 13, 16, 17, 20, 21)",()=>{
 it("flag off performs no database writes or lease claims",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","false");
  const f=makeDB();
  expect(await runToastSyncTick(f.db,now,Date.now()+60000)).toEqual({disabled:true});
  expect(f.calls).toEqual([]);
 });
 it("releases a nonce in finally, and only imports the D-1 date once",async()=>{
  const f=makeDB();
  await runToastSyncTick(f.db,now,Date.now()+60000);
  expect(f.calls).toContain("toast_acquire_lease");
  expect(f.calls).toContain("toast_release_lease");
  expect(f.imports.filter(x=>x===d)).toHaveLength(1);
  expect(f.calls.filter(x=>x==="toast_queue_backfill")).toHaveLength(1);
  await runToastSyncTick(f.db,now,Date.now()+60000);
  expect(f.imports.filter(x=>x===d)).toHaveLength(1);
  expect(f.calls.filter(x=>x==="toast_queue_backfill")).toHaveLength(1);
  expect(f.calls.filter(x=>x==="toast_release_lease")).toHaveLength(2);
 });
 it("a malformed modified scan does not block reconciliation, backfill, optional and cleanup",async()=>{
  const f=makeDB();
  m.request.mockRejectedValueOnce(new ToastApiError("invalid_response"));
  const result=await runToastSyncTick(f.db,now,Date.now()+60000) as {errors:number};
  expect(result.errors).toBeGreaterThanOrEqual(1);
  expect(f.calls).toContain("log_error");
  expect(m.reconcile).toHaveBeenCalledTimes(1);
  expect(m.optional).toHaveBeenCalledTimes(1);
  expect(f.calls).toContain("toast_queue_backfill");
  expect(f.calls).toContain("toast_cleanup_abandoned_pages");
  expect(f.calls.at(-1)).toBe("toast_release_lease");
 });
 it("scan-discovered old business date is imported before its reconciliation phase",async()=>{
  const f=makeDB();
  m.request.mockResolvedValueOnce([{businessDate:20261020}]);
  await runToastSyncTick(f.db,now,Date.now()+60000);
  expect(f.calls).toContain("toast_commit_repull_scan_window");
  expect(f.imports).toContain("2026-10-20");
  expect(m.reconcile).toHaveBeenCalledTimes(1);
  expect(f.runs.find(r=>r.kind==="repull_modified"))
   .toMatchObject({state:"completed",days_done:1});
  expect(f.calls).toContain("toast_release_lease");
 });
 it("a held lease prevents any provider read or writes",async()=>{
  const f=makeDB();f.setLease(false);
  const result=await runToastSyncTick(f.db,now,Date.now()+60000) as {acquired:number};
  expect(result.acquired).toBe(0);
  expect(m.importDay).not.toHaveBeenCalled();
  expect(m.request).not.toHaveBeenCalled();
  expect(f.calls).toEqual(["toast_acquire_lease"]);
 });
});
