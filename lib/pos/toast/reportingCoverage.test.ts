import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {unverifiedToastSalesDates} from "./reportingCoverage";
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
