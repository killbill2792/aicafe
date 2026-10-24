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
 for(const key of ["select","eq","like","in","order"] as const)query[key].mockReturnValue(query);
 query.range.mockImplementation(async(start:number,end:number)=>failure==="orders"
   ?{data:null,error:{message:"unavailable"}}
   :{data:canonicalDays.slice(start,end+1).map((business_date,i)=>({id:start+i,business_date})),error:null});
 return {db:{rpc,from:()=>query} as unknown as SupabaseClient,rpc,query};
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
 it("reads all 1000+ canonical orders, not the first page as proof",async()=>{
  const {db,query}=reader(["2026-10-10"],Array(1007).fill("2026-10-10"));
  expect([...await unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11")])
    .toEqual(["2026-10-10"]);
  expect(query.range).toHaveBeenCalledTimes(6);
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
 return {from:(table:string)=>table==="toast_day_owner_flags"
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
 it("analytics timeout is a SYSTEM status even without an owner flag",async()=>{
  const rows=[{business_date:date,import_state:"imported",
   recon_state:"analytics_timeout",last_error_category:null}];
  expect((await toastDayFlags(statusDb(rows),"business",date,date))[0].needsLook).toBe(true);
 });
});
