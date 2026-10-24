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
function fakeDatabase(daysTotal=1){
 const stored=new Map<string,unknown[]>();
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
   }else if(name==="toast_mark_day_failed"){
    run.state="failed";
   }else if(name==="toast_import_day"){
    imports.push(args as unknown as ImportCall);
    run.daysDone++;
    run.state=run.daysTotal>0&&run.daysDone>=run.daysTotal?"completed":"running";
    run.cursor={};
   }
   return {data:{ok:true},error:null};
  }
 };
 return {db:db as unknown as SupabaseClient,stored,imports,operations,run};
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
   expect(f.operations).toContain("toast_mark_day_failed");
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
