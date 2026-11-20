import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {unverifiedToastSalesDates,toastDayFlags} from "./reportingCoverage";
function reader(rpcDays:string[],canonicalDays:string[],failure?:string){
 const rpc=vi.fn().mockResolvedValue(failure==="rpc"
  ?{data:null,error:{message:"down"}}
  :{data:rpcDays.map(business_date=>({business_date})),error:null});
 const query={
  select:vi.fn(),eq:vi.fn(),like:vi.fn(),in:vi.fn(),order:vi.fn(),range:vi.fn()
 };
 const from=()=>{
  let selected:string[]=[];
  const chain={
   select:(...args:unknown[])=>{query.select(...args);return chain;},
   eq:(...args:unknown[])=>{query.eq(...args);return chain;},
   like:(...args:unknown[])=>{query.like(...args);return chain;},
   in:(column:string,dates:string[])=>{query.in(column,dates);selected=dates;return chain;},
   order:(...args:unknown[])=>{query.order(...args);return chain;},
   range:(start:number,end:number)=>query.range(start,end,selected),
  };
  return chain;
 };
 query.range.mockImplementation(async(start:number,end:number,dates:string[])=>failure==="orders"
   ?{data:null,error:{message:"unavailable"}}
   :{data:canonicalDays.map((business_date,i)=>({id:i,business_date}))
     .filter(row=>dates.includes(row.business_date)).slice(start,end+1),error:null});
 return {db:{rpc,from} as unknown as SupabaseClient,rpc,query};
}
describe("Toast reporting guard preserves independently verified non-Toast sales",()=>{
 it("does not block a Square/CSV day merely due to a staged Toast pilot or payment GUID",async()=>{
  const {db,query}=reader(["2026-10-11"],[]);
  expect([...await unverifiedToastSalesDates(db,"business","2026-10-11","2026-10-11")]).toEqual([]);
  expect(query.eq).toHaveBeenCalledWith("business_id","business");
  expect(query.like).toHaveBeenCalledWith("pos_order_id","toast:%");
  expect(query.in).toHaveBeenCalledWith("business_date",["2026-10-11"]);
 });
 it("blocks only dates with canonical Toast contributions, keeping other Square/CSV dates",async()=>{
  const {db}=reader(["2026-10-10","2026-10-11"],["2026-10-10"]);
  expect([...await unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11")])
   .toEqual(["2026-10-10"]);
 });
 it("does not mistake empty RPC results for zero-sale verification",async()=>{
  const {db,query}=reader([],[]);
  expect((await unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11")).size).toBe(0);
  expect(query.range).not.toHaveBeenCalled();
 });
 it.each(["rpc","orders"])("fails closed on missing %s scope proof",async failure=>{
  const {db}=reader(["2026-10-10"],[],failure);
  await expect(unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11"))
   .rejects.toThrow("unavailable");
 });
 it("proves date presence without transferring all 1000+ canonical orders",async()=>{
  const {db,query}=reader(["2026-10-10"],Array(1007).fill("2026-10-10"));
  expect([...await unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11")])
    .toEqual(["2026-10-10"]);
  expect(query.range.mock.calls).toEqual([[0,0,["2026-10-10"]]]);
 });
});

function statusDb(rows:Array<{business_date:string;import_state:string;
 recon_state:string;last_error_category:string|null}>,ownerFlagDates:string[]=[]){
 const query=(data:unknown[])=>{
  const chain:Record<string,unknown>={};
  for(const name of ["select","eq","is","gte","lte","order"])chain[name]=()=>chain;
  chain.range=async(start:number,end:number)=>({data:data.slice(start,end+1),error:null});
  return chain;
 };
 const flagged=[...new Set([...ownerFlagDates,...rows.filter(r=>r.recon_state==="mismatch"||r.recon_state==="coverage_invalid"||r.last_error_category).map(r=>r.business_date)])].map(business_date=>({business_date}));
 return {rpc:()=>query(flagged),from:(table:string)=>table==="toast_day_owner_flags"
  ?query(ownerFlagDates.map(business_date=>({business_date,restaurant_guid:"restaurant"})))
  :query(rows)} as unknown as SupabaseClient;
}
describe("owner/system flags remain distinct in reports",()=>{
 const date="2026-10-16";
 it("reports imported day as needing look after failed re-pull",async()=>{
  const rows=[{business_date:date,import_state:"imported",
   recon_state:"matched",last_error_category:"invalid_response"}];
  expect(await toastDayFlags(statusDb(rows),"business",date,date))
   .toEqual([{date,status:"imported",needsLook:true}]);
 });
 it("keeps a recovered import clear of stale system warnings",async()=>{
  const rows=[{business_date:date,import_state:"imported",
   recon_state:"matched",last_error_category:null}];
  expect((await toastDayFlags(statusDb(rows),"business",date,date))[0].needsLook).toBe(false);
 });
 it("owner's active flag survives automated reconciliation to matched",async()=>{
  const rows=[{business_date:date,import_state:"imported",
   recon_state:"matched",last_error_category:null}];
  expect((await toastDayFlags(statusDb(rows,[date]),"business",date,date))[0].needsLook).toBe(true);
 });
 it("analytics timeout falls back without adding a Needs a look item",async()=>{
  const rows=[{business_date:date,import_state:"imported",
   recon_state:"analytics_timeout",last_error_category:null}];
  expect((await toastDayFlags(statusDb(rows),"business",date,date))[0].needsLook).toBe(false);
 });
});

it("paginates shared attention beyond the first two hundred combinations",async()=>{
 const flags=Array.from({length:251},(_,i)=>new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10));
 const last=flags[flags.length-1];
 const rows=[{business_date:last,import_state:"imported",recon_state:"matched",last_error_category:null}];
 const result=await toastDayFlags(statusDb(rows,flags),"business",flags[0],last);
 expect(result).toEqual([{date:last,status:"imported",needsLook:true}]);
});

describe("U1 coverage workload and completeness evidence",()=>{
  it("retains dates beyond the first 1000 orders and rejects partial results when a date read fails",async()=>{
    const dates=["2026-10-10","2026-10-11"];
    const many=Array(1007).fill(dates[0]).concat(dates[1]);
    const good=reader(dates,many);
    expect([...await unverifiedToastSalesDates(good.db,"business",dates[0],dates[1])]).toEqual(dates);
    const failed=reader(dates,many);
    failed.query.range.mockImplementationOnce(async()=>({data:[{id:0,business_date:dates[0]}],error:null}))
      .mockRejectedValueOnce(new Error("late source date unavailable"));
    await expect(unverifiedToastSalesDates(failed.db,"business",dates[0],dates[1])).rejects.toThrow("late source date unavailable");
    expect(failed.query.range).toHaveBeenCalledTimes(2);
  });
  it("does not page thousands of individual order IDs merely to establish calendar-day presence",async()=>{
    const dates=["2026-10-10","2026-10-11"];
    const {db,query}=reader(dates,Array(11711).fill(dates[0]).concat(dates[1]));
    expect([...await unverifiedToastSalesDates(db,"business",dates[0],dates[1])]).toEqual(dates);
    // With two possible dates, the existence/aggregation result must not grow with order count.
    expect(query.range.mock.calls).toEqual(dates.map(date=>[0,0,[date]]));
  });
});
