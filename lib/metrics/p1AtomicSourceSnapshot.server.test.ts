import { describe,expect,it,vi,beforeEach } from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./p1Readers.server",()=>({authorizedOwnerP1:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn()}));
import { authorizedOwnerP1 } from "./p1Readers.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { atomicP1SourceSchema,readAuthorizedAtomicP1SourceSnapshot } from "./p1AtomicSourceSnapshot.server";

const owner=vi.mocked(authorizedOwnerP1);
const connect=vi.mocked(createServerSupabaseClient);
const cafe="a12a12a1-1111-4111-8111-a12a12a12a12";
const keys=["menu","ingredients","ingredientPrices","recipes","employees",
  "dailyRollups","expenses","recurringCosts","imports"] as const;
const base={
  contract:"p1.authoritative_snapshot.v1",businessId:cafe,revision:"25",
  timezone:"America/Los_Angeles",currency:"USD",
  payroll:{rate:0.12,status:"estimated",source:"system_estimate"},
  sources:Object.fromEntries(keys.map(k=>[k,[]])),
  truncated:Object.fromEntries(keys.map(k=>[k,false])),
  coverage:"not_proven_by_revision",
};
beforeEach(()=>{
  vi.resetAllMocks();
  owner.mockResolvedValue({identity:{businessId:cafe,timezone:base.timezone,
    currency:"USD"}} as Awaited<ReturnType<typeof authorizedOwnerP1>>);
  connect.mockResolvedValue({rpc:vi.fn(async()=>({data:base,error:null}))}
    as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
});
describe("P1 authoritative source adapter never invents a DB revision",()=>{
  it("accepts one exact owner-authorized, revision-backed single-RPC observation",async()=>{
    const result=await readAuthorizedAtomicP1SourceSnapshot();
    expect(result).toMatchObject({status:"available",
      snapshot:{businessId:cafe,revision:"25",coverage:"not_proven_by_revision"}});
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("denies foreign tenant or wrong business timezone before returning records",async()=>{
    for(const data of [
      {...base,businessId:"b12b12b1-1111-4111-8111-b12b12b12b12"},
      {...base,timezone:"America/New_York"},
      {...base,currency:"EUR"},
    ]){
      connect.mockResolvedValueOnce({rpc:vi.fn(async()=>({data,error:null}))}
        as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
      expect(await readAuthorizedAtomicP1SourceSnapshot())
        .toMatchObject({status:"unavailable",reason:"invalid_source_snapshot"});
    }
  });
  it("fails closed on missing DB revision, malformed money and claimed complete coverage",async()=>{
    for(const data of [
      {...base,revision:null},
      {...base,revision:"0"},
      {...base,payroll:{...base.payroll,rate:Number.NaN}},
      {...base,coverage:"complete"},
      {...base,truncated:{...base.truncated,menu:true}},
      {...base,sources:{...base.sources,menu:[{id:cafe,name:"Latte",
        price_cents:100.5,is_active:true,category:"ESPRESSO_DRINK"}]}},
    ]){
      expect(atomicP1SourceSchema.safeParse(data).success).toBe(false);
    }
  });
  it("treats a missing RPC or authorization failure as unavailable",async()=>{
    connect.mockResolvedValueOnce({rpc:vi.fn(async()=>({
      data:null,error:{message:"migration not applied"}}))}
      as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
    expect(await readAuthorizedAtomicP1SourceSnapshot())
      .toMatchObject({status:"unavailable",reason:"unauthorized_or_unconfigured"});
    owner.mockRejectedValueOnce(new Error("foreign member"));
    expect(await readAuthorizedAtomicP1SourceSnapshot())
      .toMatchObject({status:"unavailable",reason:"unauthorized_or_unconfigured"});
  });
});
