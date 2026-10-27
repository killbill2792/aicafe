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
 const scan={scan_local_day:null as string|null,scan_start:null as string|null,
  scan_end:null as string|null,scan_window_start:null as string|null,scan_page:null as number|null};
 let claim=true;
 const resolve=(table:string,filters:Record<string,unknown>)=>{
  if(table==="toast_location_mappings")return [mapping];
  if(table==="toast_day_status"){
   const day=String(filters.business_date);
   return status.has(day)?[{import_state:"imported"}]:[];
  }
  if(table==="toast_repull_scan_state")
   return scanDay||scan.scan_local_day?[{last_local_day:scanDay,...scan}]:[];
  if(table==="toast_sync_runs"){
   if(filters.kind==="backfill" && !filters.state && !runs.some(r=>r.kind==="backfill"))
    return backfillQueued?[{id:"backfill-placeholder"}]:[];
   return runs.filter(r=>Object.entries(filters).every(([k,v])=>k==="business_id"?v===b:k==="restaurant_guid"?v===g:r[k as keyof Run]===v));
  }
  return [];
 };
 const db={
  from(table:string){
   const filters:Record<string,unknown>={};
   const included:Record<string,unknown[]>={};
   const q={
    select(_x:string){return q;},eq(k:string,v:unknown){filters[k]=v;return q;},
    not(_k:string,_op:string,_val:unknown){return q;},
    in(k:string,vals:unknown[]){included[k]=vals;return q;},
    order(_k:string){return q;},range(_start:number,_end:number){return q;},update(_value:unknown){return q;},limit(_n:number){return q;},
    async maybeSingle(){return {data:resolve(table,filters)[0]??null,error:null};},
    async single(){return {data:resolve(table,filters)[0]??null,error:null};},
    async upsert(_row:unknown){calls.push("log_error");return {error:null};},
    then(yes:(v:unknown)=>unknown, no?:((e:unknown)=>unknown)){
     return Promise.resolve({data:resolve(table,filters).filter((row:Record<string,unknown>)=>
      Object.entries(included).every(([k,vals])=>vals.includes(row[k]))),error:null}).then(yes,no);
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
   else if(name==="toast_checkpoint_repull_scan_page"){
    if(!scan.scan_local_day){
     scan.scan_local_day=String(args.p_local_day);
     scan.scan_start=String(args.p_scan_start);scan.scan_end=String(args.p_scan_end);
     scan.scan_window_start=String(args.p_window_start);scan.scan_page=1;
    }
    if(scan.scan_page!==args.p_page||scan.scan_window_start!==args.p_window_start)
     return {data:false,error:{message:"stale scan cursor"}};
    for(const date of args.p_days as string[]){
     if(!runs.some(r=>r.kind==="repull_modified"&&r.requested_from===date))
      runs.push({id:"repull-"+date,kind:"repull_modified",state:"queued",
       requested_from:date,requested_to:date,days_done:0,days_total:1,cursor:{},resume_at:null});
    }
    if(args.p_last_page){
     if(args.p_window_end===args.p_scan_end){
      scanDay=String(args.p_local_day);
      scan.scan_local_day=null;scan.scan_start=null;scan.scan_end=null;
      scan.scan_window_start=null;scan.scan_page=null;
     }else{scan.scan_window_start=String(args.p_window_end);scan.scan_page=1;}
    }else scan.scan_page=(scan.scan_page??0)+1;
   }
   return {data:true,error:null};
  }
 };
 m.importDay.mockImplementation(async (_db:unknown,p:{runId:string;businessDate:string})=>{
  imports.push(p.businessDate);
  const run=runs.find(r=>r.id===p.runId)!;
  run.days_done++;run.state=run.days_done>=run.days_total?"completed":"running";run.cursor={};
  status.add(p.businessDate);
  return {costsPending:false};
 });
 return {db:db as unknown as SupabaseClient,calls,imports,runs,status,scan,
  get scanDay(){return scanDay;},setLease(v:boolean){claim=v;},
  get backfillQueued(){return backfillQueued;}};
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
  expect(f.calls).toContain("toast_checkpoint_repull_scan_page");
  expect(f.imports).toContain("2026-10-20");
  expect(m.reconcile).toHaveBeenCalledTimes(1);
  expect(f.runs.find(r=>r.kind==="repull_modified"))
   .toMatchObject({state:"completed",days_done:1});
  expect(f.calls).toContain("toast_release_lease");
 });
 it("starts a queued 65-day first backfill before four repulls, within the full single-café tick",async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  const f=makeDB();
  const backfill:Run={id:"first-65",kind:"backfill",state:"queued",
   requested_from:"2026-08-19",requested_to:"2026-10-22",
   days_done:0,days_total:65,cursor:{},resume_at:null};
  f.runs.push(backfill);
  for(let i=0;i<4;i++){
   const day="2026-10-"+String(18+i).padStart(2,"0");
   f.runs.push({id:"repull-"+i,kind:"repull_modified",
    state:i%2?"paused_rate_limited":"queued",
    requested_from:day,requested_to:day,days_done:0,days_total:1,
    cursor:{},resume_at:null});
  }
  f.status.add(d); // D-1 daily is already current.
  const importDay=m.importDay.getMockImplementation()!;
  m.importDay.mockImplementation(async(...args:unknown[])=>{
   vi.setSystemTime(Date.now()+30000); // >60s for five days, <240s total.
   return importDay(...args);
  });
  m.reconcile.mockImplementation(async()=>{
   expect(backfill.days_done).toBe(5);
   return 0;
  });
  try{
   const first=await runToastSyncTick(f.db,now,Date.now()+240000);
   expect(first).toMatchObject({acquired:1});
   expect(backfill).toMatchObject({days_done:5,state:"running"});
   expect(f.imports).toHaveLength(5);
   expect(new Set(f.imports).size).toBe(5);
   expect(f.imports[0]).toBe("2026-08-19");
   expect(f.runs.filter(r=>r.kind==="repull_modified").every(r=>r.days_done===0)).toBe(true);
   expect(m.request).not.toHaveBeenCalled(); // no overlapping modified scan.
   expect(f.calls).toContain("toast_release_lease");
   vi.setSystemTime(now);
   await runToastSyncTick(f.db,now,Date.now()+240000);
   expect(backfill.days_done).toBe(10);
   expect(f.imports).toHaveLength(10);
   expect(new Set(f.imports).size).toBe(10);
   expect(f.imports[9]).toBe("2026-08-28");
  }finally{vi.useRealTimers();}
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
it("120 mappings rotate through all cafés in three full ticks despite a café using its slice",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const maps=Array.from({length:120},(_,i)=>({business_id:"cafe-"+String(i).padStart(3,"0"),restaurant_guid:g,location_id:l,
  toast_time_zone:"America/Los_Angeles",closeout_hour:4,verified_at:now.toISOString(),info_refreshed_at:now.toISOString(),last_tick_started_at:null as string|null}));
 const reached=new Set<string>();let pages=0;
 m.reconcile.mockImplementation(async(_db:unknown,p:{businessId:string})=>{reached.add(p.businessId);vi.setSystemTime(Date.now()+6000);return 0;});
 const db={from(table:string){let patch:Record<string,unknown>|null=null;const filters:Record<string,string>={};
  const q={select(){return q;},eq(k:string,v:string){filters[k]=v;return q;},in(){return q;},not(){return q;},order(){return q;},limit(){return q;},
   update(p:Record<string,unknown>){patch=p;return q;},upsert(){return q;},
   async range(start:number,end:number){pages++;return {data:[...maps].sort((a,b)=>(a.last_tick_started_at??"").localeCompare(b.last_tick_started_at??"")||a.business_id.localeCompare(b.business_id)).slice(start,end+1),error:null};},
   async maybeSingle(){return {data:table==="toast_day_status"?{import_state:"imported"}:null,error:null};},
   then(ok:(v:unknown)=>unknown){if(patch){const map=maps.find(m=>m.business_id===filters.business_id);if(map)Object.assign(map,patch);}
    return Promise.resolve({data:[],error:null}).then(ok);}};return q;},
  async rpc(name:string){return {data:name==="toast_acquire_lease"?"fair-lease":true,error:null};}} as unknown as SupabaseClient;
 const logging=vi.spyOn(console,"info").mockImplementation(()=>{});
 try{
  for(let tick=0;tick<3;tick++)await runToastSyncTick(db,new Date(),Date.now()+240000);
  expect(reached.size).toBe(120);expect(pages).toBe(3);
  expect(logging).toHaveBeenCalledWith("toast_tick_skipped",expect.objectContaining({businessId:"cafe-040"}));
 }finally{logging.mockRestore();vi.useRealTimers();}
});

it("resumes an exact 1,200-order scan across short slices without skipping the terminal page",async()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const f=makeDB(),paths:string[]=[];
 m.request.mockImplementation(async(path:string)=>{
  paths.push(path);vi.setSystemTime(Date.now()+10000);
  const page=Number(new URL(path,"https://example.invalid").searchParams.get("page"));
  return page<=12?Array.from({length:100},()=>({businessDate:20261020})):[];
 });
 try{
  await runToastSyncTick(f.db,now,Date.now()+60000);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.length).toBeLessThan(13);
  expect(f.scanDay).toBeNull();
  expect(f.scan.scan_page).toBe(paths.length+1);
  for(let attempt=0;attempt<5&&f.scanDay===null;attempt++)
   await runToastSyncTick(f.db,now,Date.now()+60000);
  expect(paths).toHaveLength(13);
  expect(paths.map(path=>new URL(path,"https://example.invalid").searchParams.get("page")))
   .toEqual(Array.from({length:13},(_,i)=>String(i+1)));
  expect(f.scanDay).toBe("2026-10-23");
  expect(f.scan.scan_local_day).toBeNull();
  expect(f.runs.filter(r=>r.kind==="repull_modified")).toHaveLength(1);
  expect(f.imports).toContain("2026-10-20");
  await runToastSyncTick(f.db,now,Date.now()+60000);
  expect(paths).toHaveLength(13);
 }finally{vi.useRealTimers();}
});
