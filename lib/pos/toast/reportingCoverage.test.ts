import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {unverifiedToastSalesDates,toastDayFlags} from "./reportingCoverage";
function reader(rpcDays:string[],canonicalDays:string[],failure?:string){
 const rpc=vi.fn().mockResolvedValue(failure==="rpc"
  ?{data:null,error:{message:"down"}}
  :{data:rpcDays.map(business_date=>({business_date})),error:null});
 const query={
  select:vi.fn(),eq:vi.fn(),like:vi.fn(),in:vi.fn(),limit:vi.fn()
 };
 for(const key of ["select","eq","like","in"] as const)query[key].mockReturnValue(query);
 query.limit.mockResolvedValue(failure==="orders"
   ?{data:null,error:{message:"unavailable"}}
   :{data:canonicalDays.map(business_date=>({business_date})),error:null});
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
  expect(query.limit).not.toHaveBeenCalled();
 });
 it.each(["rpc","orders"])("fails closed on missing %s scope proof",async failure=>{
  const {db}=reader(["2026-10-10"],[],failure);
  await expect(unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11"))
   .rejects.toThrow("unavailable");
 });
 it("rejects truncated Toast canonical days instead of declaring some as verified",async()=>{
  const {db}=reader(["2026-10-10"],Array(1000).fill("2026-10-10"));
  await expect(unverifiedToastSalesDates(db,"business","2026-10-10","2026-10-11"))
   .rejects.toThrow("unavailable");
 });
});

describe("P1 imported day errors remain visible in reports",()=>{
 it("reports the prior imported day as imported and needing look after a failed re-pull",async()=>{
  const rows=[{business_date:"2026-10-16",import_state:"imported",
   recon_state:"matched",last_error_category:"invalid_response"}];
  const chain:Record<string,unknown>={};
  for(const method of ["select","eq","gte","lte","order","is"])
   chain[method]=()=>chain;
  chain.limit=async()=>({data:rows,error:null});
  const db={from:(table:string)=>table==="toast_day_owner_flags"?{
   select:()=>({eq:()=>({is:()=>({gte:()=>({lte:()=>({limit:async()=>({data:[],error:null})})})})})})
  }:chain} as unknown as SupabaseClient;
  const flags=await toastDayFlags(db,"business","2026-10-16","2026-10-16");
  expect(flags).toEqual([{date:"2026-10-16",status:"imported",needsLook:true}]);
 });
 it("keeps a recovered imported day free of stale errors",async()=>{
  const chain:Record<string,unknown>={};
  for(const method of ["select","eq","gte","lte","order"])
   chain[method]=()=>chain;
  chain.limit=async()=>({data:[{business_date:"2026-10-16",import_state:"imported",
   recon_state:"matched",last_error_category:null}],error:null});
  const db={from:()=>chain} as unknown as SupabaseClient;
  expect((await toastDayFlags(db,"business","2026-10-16","2026-10-16"))[0].needsLook).toBe(false);
 });
});
