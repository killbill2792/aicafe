import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type {SupabaseClient} from "@supabase/supabase-js";
import {unverifiedToastSalesDates} from "./reportingCoverage";
describe("Toast reporting provenance is fail-closed and tenant scoped",()=>{
 it("only reports blocked dates returned by tenant-scoped RPC",async()=>{
  const rpc=vi.fn().mockResolvedValue({data:[{business_date:"2026-10-10"}],error:null});
  const result=await unverifiedToastSalesDates({rpc} as unknown as SupabaseClient,
    "tenant-id","2026-10-01","2026-10-11");
  expect([...result]).toEqual(["2026-10-10"]);
  expect(rpc).toHaveBeenCalledWith("toast_unverified_sales_dates",{
   p_business_id:"tenant-id",p_from:"2026-10-01",p_to:"2026-10-11"
  });
 });
 it("never calls an RPC failure proof of verified coverage",async()=>{
  const rpc=vi.fn().mockResolvedValue({data:null,error:{message:"denied"}});
  await expect(unverifiedToastSalesDates({rpc} as unknown as SupabaseClient,
    "x","2026-10-01","2026-10-11")).rejects.toThrow("unavailable");
 });
});
