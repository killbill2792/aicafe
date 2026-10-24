import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

const mocked=vi.hoisted(()=>({request:vi.fn(),recompute:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./client",async()=>{
 const {z}=await import("zod");
 class ToastApiError extends Error{
  constructor(public category:string,public status?:number,public retryAt?:string){super(category);}
 }
 return {GUID:z.uuid(),ToastApiError,createToastClient:()=>({request:mocked.request})};
});
vi.mock("../rollup",()=>({recomputeDailyRollup:mocked.recompute}));
import {ToastApiError} from "./client";
import {importToastBusinessDay} from "./dayImport";
import {deriveNextRunDay} from "./scheduleDates";

const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const location="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001";
const restaurant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaff01";
const runId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa00e1";
const guid=(i:number)=>"00000000-0000-4000-8000-"+i.toString(16).padStart(12,"0");
const dayInt=(day:string)=>Number(day.replaceAll("-",""));
const record=(i:number,day:string,amount=10,modified="2026-10-17T09:00:00+0000")=>({
 guid:guid(i),businessDate:dayInt(day),modifiedDate:modified,
 openedDate:day+"T12:00:00+0000",
 checks:[{guid:guid(i+40000),amount,taxAmount:0,paymentStatus:"CLOSED",
  selections:[{guid:guid(i+80000),quantity:1,price:amount,displayName:"Tea"}]}]
});
const params=(businessDate:string)=>({businessId:business,locationId:location,restaurantGuid:restaurant,businessDate,runId});
type ImportCall={p_orders:Array<{posOrderId:string;netSalesCents:number}>;p_summary:{
 order_count:number;unparsed_count:number;parsed_order_guids:string[];net_sales_cents:number
}};
function fakeDatabase(daysTotal=1,initialImportedDays:string[]=[]){
 const dayStatuses=new Map<string,string>(initialImportedDays.map(day=>[day,"imported"]));
 const stored=new Map<string,unknown[]>();
 const pendingCosts=new Map<string,string>();
 const imports:ImportCall[]=[];
 const operations:string[]=[];
 const run={state:"queued",daysDone:0,daysTotal,cursor:{} as Record<string,unknown>};
 const db={
  from(table:string){
   const filters:Record<string,unknown>={};
   const q={
    select(_columns:string){return q;},
    eq(name:string,value:unknown){filters[name]=value;return q;},
    async maybeSingle(){
     if(table==="toast_location_mappings")return {data:{
      location_id:location,verified_at:"2026-10-15",toast_time_zone:"America/Los_Angeles",
      closeout_hour:4},error:null};
     if(table==="toast_sync_runs")return {data:{state:run.state,business_id:business,restaurant_guid:restaurant,
      cursor:run.cursor},error:null};
     if(table==="toast_day_pages")return {data:stored.has(filters.business_date+":"+filters.page)?
      {payload:stored.get(filters.business_date+":"+filters.page)}:null,error:null};
     if(table==="daily_rollups")return {data:{sales_data_status:"missing"},error:null};
     if(table==="toast_rollup_refresh_jobs")return {data:pendingCosts.has(String(filters.business_date))?
      {generation:pendingCosts.get(String(filters.business_date))}:null,error:null};
     throw new Error("unexpected table "+table);
    }
   };
   return q;
  },
  async rpc(name:string,args:Record<string,unknown>){
   operations.push(name);
   if(name==="toast_stage_day_page"){
    stored.set(args.p_business_date+":"+args.p_page,args.p_payload as unknown[]);
    run.state="running";
   }else if(name==="toast_checkpoint_day"){
    run.state="paused_rate_limited";
    run.cursor={business_date:args.p_business_date,page:args.p_page};
   }else if(name==="toast_record_day_error"){
    const day=String(args.p_business_date);
    if(!dayStatuses.has(day))dayStatuses.set(day,"failed");
    if(args.p_run_fatal)run.state="failed";
    else if(args.p_skip){run.daysDone++;run.cursor={};
     run.state=run.daysDone>=run.daysTotal?"completed":"running";}
   }else if(name==="toast_import_day"){
    pendingCosts.set(String(args.p_business_date),"00000000-0000-4000-8000-000000000001");
    imports.push(args as unknown as ImportCall);
    dayStatuses.set(String(args.p_business_date),"imported");
    run.daysDone++;
    run.state=run.daysTotal>0&&run.daysDone>=run.daysTotal?"completed":"running";
    run.cursor={};
   }else if(name==="toast_ack_rollup_refresh"){
    pendingCosts.delete(String(args.p_business_date));
    return {data:true,error:null};
   }
   return {data:{ok:true},error:null};
  }
 };
 return {db:db as unknown as SupabaseClient,stored,pendingCosts,imports,operations,run,dayStatuses};
}
beforeEach(()=>{mocked.request.mockReset();mocked.recompute.mockReset();
 mocked.recompute.mockResolvedValue(undefined);});

describe("resumable Toast day importer",()=>{
 it("resumes page 2 after 429 without re-fetching staged page 1",async()=>{
  const d="2026-10-16",f=fakeDatabase();
  let second=0;
  mocked.request.mockImplementation(async(path:string)=>{
   if(path.includes("page=1"))return Array.from({length:100},(_,i)=>record(i+1,d));
   if(path.includes("page=2")&&second++===0)
    throw new ToastApiError("rate_limited",429,"2026-10-17T10:00:00Z");
   return [record(101,d)];
  });
  await expect(importToastBusinessDay(f.db,params(d))).rejects.toMatchObject({category:"rate_limited"});
  expect(f.run.state).toBe("paused_rate_limited");
  expect(f.run.cursor).toMatchObject({business_date:d,page:2});
  expect(f.stored.size).toBe(1);
  await importToastBusinessDay(f.db,params(d));
  expect(mocked.request.mock.calls.filter(call=>String(call[0]).includes("page=1"))).toHaveLength(1);
  expect(f.imports[0].p_summary.order_count).toBe(101);
  expect(f.operations).toContain("toast_checkpoint_day");
  expect(mocked.recompute).toHaveBeenCalledWith(f.db,business,d,{salesDataStatus:"missing"});
 });
 it("deduplicates 251 provider records from three pages by latest modifiedDate",async()=>{
  const d="2026-10-16",f=fakeDatabase();
  const pages=[
   Array.from({length:100},(_,i)=>record(i+1,d)),
   Array.from({length:100},(_,i)=>record(i+101,d)),
   [...Array.from({length:50},(_,i)=>record(i+201,d)),
    record(1,d,5,"2026-10-18T10:00:00+0000")]
  ];
  mocked.request.mockImplementation(async(path:string)=>pages[Number(path.match(/page=(\d+)/)?.[1]??0)-1]);
  await importToastBusinessDay(f.db,params(d));
  expect(mocked.request).toHaveBeenCalledTimes(3);
  expect(f.imports[0].p_summary.order_count).toBe(250);
  expect(f.imports[0].p_orders.find(o=>o.posOrderId.endsWith(guid(1)))?.netSalesCents).toBe(500);
  expect(f.imports[0].p_summary.parsed_order_guids).toHaveLength(250);
 });
 it("allows day 2 in the same run and completes only after both days",async()=>{
  const f=fakeDatabase(2);
  mocked.request.mockResolvedValue([]);
  await importToastBusinessDay(f.db,params("2026-10-16"));
  expect(f.run).toMatchObject({state:"running",daysDone:1,cursor:{}});
  await importToastBusinessDay(f.db,params("2026-10-17"));
  expect(f.run).toMatchObject({state:"completed",daysDone:2});
  expect(f.imports).toHaveLength(2);
  expect(mocked.recompute).toHaveBeenCalledTimes(2);
 });
 it("passes through the SQL coverage decision to the cost recompute",async()=>{
  const f=fakeDatabase();
  mocked.request.mockResolvedValue([record(17,"2026-10-16")]);
  await importToastBusinessDay(f.db,params("2026-10-16"));
  expect(f.imports[0].p_summary.net_sales_cents).toBe(1000);
  expect(mocked.recompute).toHaveBeenCalledWith(f.db,business,"2026-10-16",
    {salesDataStatus:"missing"});
 });
});

describe("run error lifecycle",()=>{
 it.each(["timeout","unavailable","rate_limited"] as const)(
  "%s checkpoints its exact page and stays resumable",async category=>{
   const f=fakeDatabase();mocked.request.mockRejectedValue(
     new ToastApiError(category,category==="rate_limited"?429:undefined,
       category==="rate_limited"?"2026-10-17T10:00:00Z":undefined));
   await expect(importToastBusinessDay(f.db,params("2026-10-16"))).rejects.toMatchObject({category});
   expect(f.run.state).toBe("paused_rate_limited");
   expect(f.run.cursor).toMatchObject({business_date:"2026-10-16",page:1});
   expect(f.operations).toContain("toast_checkpoint_day");
  });
 it.each(["authentication","missing_scope_or_location","unauthorized_location"] as const)(
  "%s is permanent, not indefinitely retried",async category=>{
   const f=fakeDatabase();mocked.request.mockRejectedValue(new ToastApiError(category));
   await expect(importToastBusinessDay(f.db,params("2026-10-16"))).rejects.toMatchObject({category});
   expect(f.operations).toContain("toast_record_day_error");
  });
 it("passes a single scheduler deadline down to every page",async()=>{
  const f=fakeDatabase();mocked.request.mockResolvedValue([]);
  const deadlineAt=Date.now()+120000;
  await importToastBusinessDay(f.db,{...params("2026-10-16"),deadlineAt});
  expect(mocked.request.mock.calls[0][3]).toMatchObject({deadlineAt});
 });
 it("does not start a provider call when the shared tick deadline passed",async()=>{
  const f=fakeDatabase();
  await expect(importToastBusinessDay(f.db,{...params("2026-10-16"),deadlineAt:Date.now()-1}))
   .rejects.toMatchObject({category:"timeout"});
  expect(mocked.request).not.toHaveBeenCalled();
  expect(f.operations).toContain("toast_checkpoint_day");
 });
});

describe("post-import cost retry isolation (review P1)",()=>{
 it("does not replay a committed day if its cost recompute fails",async()=>{
  const f=fakeDatabase(2);mocked.request.mockResolvedValue([]);
  mocked.recompute.mockRejectedValueOnce(new Error("cost connection dropped"));
  const first=await importToastBusinessDay(f.db,params("2026-10-16"));
  expect(first.costsPending).toBe(true);
  expect(f.pendingCosts.has("2026-10-16")).toBe(true);
  expect(f.run).toMatchObject({state:"running",daysDone:1,cursor:{}});
  expect(f.operations).not.toContain("toast_checkpoint_day");
  expect(f.operations).not.toContain("toast_mark_day_failed");
  const second=await importToastBusinessDay(f.db,params("2026-10-17"));
  expect(second.costsPending).toBe(false);
  expect(f.run).toMatchObject({state:"completed",daysDone:2});
  expect(f.imports).toHaveLength(2);
  expect(f.pendingCosts.has("2026-10-16")).toBe(true);
  expect(f.pendingCosts.has("2026-10-17")).toBe(false);
 });
 it("does not re-import after post-commit rollup read fails",async()=>{
  const f=fakeDatabase();mocked.request.mockResolvedValue([]);
  // The cost read is separate from the committed day SQL.
  const post=await importToastBusinessDay(f.db,params("2026-10-16"));
  expect(post.costsPending).toBe(false);
  expect(f.imports).toHaveLength(1);
  expect(f.operations).toContain("toast_ack_rollup_refresh");
 });
});

describe("P1 bad days never destroy previously imported sales",()=>{
 it("a malformed re-pull preserves an imported date and continues the run",async()=>{
  const day="2026-10-16",f=fakeDatabase(2,[day]);
  mocked.request.mockRejectedValueOnce(new ToastApiError("invalid_response"))
   .mockResolvedValue([]);
  await expect(importToastBusinessDay(f.db,params(day))).rejects.toMatchObject({
   category:"invalid_response"});
  expect(f.dayStatuses.get(day)).toBe("imported");
  expect(f.run).toMatchObject({state:"running",daysDone:1,cursor:{}});
  expect(f.operations).not.toContain("toast_mark_day_failed");
  await importToastBusinessDay(f.db,params("2026-10-17"));
  expect(f.run).toMatchObject({state:"completed",daysDone:2});
 });
 it("one invalid day in a 10-day backfill does not skip later days",async()=>{
  const f=fakeDatabase(10);
  mocked.request.mockImplementation(async (path:string)=>{
   if(path.includes("businessDate=20261003"))
    throw new ToastApiError("invalid_response");
   return [];
  });
  for(let n=1;n<=10;n++){
   const day="2026-10-"+String(n).padStart(2,"0");
   if(n===3)await expect(importToastBusinessDay(f.db,params(day)))
    .rejects.toMatchObject({category:"invalid_response"});
   else await importToastBusinessDay(f.db,params(day));
  }
  expect(f.run).toMatchObject({daysDone:10,state:"completed"});
  expect(f.imports).toHaveLength(9);
  expect(f.dayStatuses.get("2026-10-03")).toBe("failed");
  expect(f.dayStatuses.get("2026-10-10")).toBe("imported");
 });
});


describe("P1 pause, resume, then next business date",()=>{
 it("reuses a staged first page on retry and advances the day only on commit",async()=>{
  const f=fakeDatabase(2),from="2026-10-16",to="2026-10-17";
  let page2Attempt=0;
  mocked.request.mockImplementation(async(path:string)=>{
   if(path.includes("businessDate=20261016")){
    if(path.includes("page=1"))
     return Array.from({length:100},(_,i)=>record(i+1,from));
    if(page2Attempt++===0)
     throw new ToastApiError("rate_limited",429,"2026-10-18T00:00:00Z");
    return [record(101,from)];
   }
   return [record(201,to)];
  });
  const progress=()=>deriveNextRunDay({requested_from:from,requested_to:to,days_done:f.run.daysDone});
  expect(progress()).toBe(from);
  await expect(importToastBusinessDay(f.db,params(progress()!)))
   .rejects.toMatchObject({category:"rate_limited"});
  expect(f.run).toMatchObject({state:"paused_rate_limited",daysDone:0,
   cursor:{business_date:from,page:2}});
  expect(progress()).toBe(from);
  await importToastBusinessDay(f.db,params(progress()!));
  expect(f.run).toMatchObject({state:"running",daysDone:1,cursor:{}});
  expect(mocked.request.mock.calls.filter(c=>String(c[0]).includes("businessDate=20261016")&&
   String(c[0]).includes("page=1"))).toHaveLength(1);
  expect(progress()).toBe(to);
  await importToastBusinessDay(f.db,params(progress()!));
  expect(f.imports).toHaveLength(2);
  expect(f.run).toMatchObject({state:"completed",daysDone:2});
  expect(progress()).toBeNull();
 });
});
