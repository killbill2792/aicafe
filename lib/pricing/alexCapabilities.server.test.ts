import { describe,expect,it,vi,beforeEach } from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({
  readAuthorizedAtomicP1SourceSnapshot:vi.fn(),
}));
import { readAuthorizedAtomicP1SourceSnapshot } from
  "@/lib/metrics/p1AtomicSourceSnapshot.server";
import { createP2Registry, type TrustedReadScope } from
  "@/lib/ai/supervisor/p2/registry";
import { ALEX_REVIEW_ID,ALEX_SIMULATE_ID,buildAlexPricingRegistrations } from
  "./alexCapabilities.server";
import type { AtomicP1SourceSnapshot } from
  "@/lib/metrics/p1AtomicSourceSnapshot.server";

const cafe="a0000000-0000-4000-8000-000000000999";
const id="a0000000-0000-4000-8000-000000000001";
const ing="a0000000-0000-4000-8000-000000000100";
const snapshot={
  contract:"p1.authoritative_snapshot.v1",businessId:cafe,revision:"100",
  timezone:"America/Los_Angeles",currency:"USD",
  payroll:{rate:0.12,status:"confirmed",source:"business"},
  sources:{
    menu:[{id,name:"Latte 12 oz",price_cents:525,is_active:true,
      category:"ESPRESSO_DRINK"}],
    ingredients:[{id:ing,name:"Milk",base_unit:"ml"}],
    ingredientPrices:[{id:"a0000000-0000-4000-8000-000000000200",
      ingredient_id:ing,effective_from:"2026-09-01",
      cost_per_base_unit_micros:100000,source:"manual"}],
    recipes:[{menu_item_id:id,ingredient_id:ing,quantity:200}],
    employees:[],dailyRollups:[],expenses:[],recurringCosts:[],imports:[],
  },
  truncated:{menu:false,ingredients:false,ingredientPrices:false,
    recipes:false,employees:false,dailyRollups:false,expenses:false,
    recurringCosts:false,imports:false},
  coverage:"not_proven_by_revision",
} as AtomicP1SourceSnapshot;
const rpc=vi.mocked(readAuthorizedAtomicP1SourceSnapshot);
const registry=createP2Registry(buildAlexPricingRegistrations());
const scope:TrustedReadScope={
  role:"owner",businessId:cafe,shadowEnabled:true,
  identity:{businessId:cafe,currency:"USD",timezone:"America/Los_Angeles",
    asOf:"2026-10-16T12:00:00-07:00"},
  tools:{} as TrustedReadScope["tools"],
};
beforeEach(()=>{
  vi.resetAllMocks();
  rpc.mockResolvedValue({status:"available",snapshot});
});
describe("Alex P2/P3 standalone registry safety",()=>{
  it("validates and discovers both independently registered domain operations",()=>{
    expect(registry.discover(scope).map(x=>x.id)).toContain(ALEX_REVIEW_ID);
    expect(registry.discoverSimulations(scope).map(x=>x.id)).toContain(ALEX_SIMULATE_ID);
  });
  it("reads only authenticated source snapshot and double-checks its epoch",async()=>{
    const out=await registry.invoke(scope,ALEX_REVIEW_ID,{purpose:"pricing_review",
      selection:{kind:"specific",items:[{productId:id}]}});
    expect(out).toMatchObject({status:"partial",value:{items:[{
      productId:id,currentPriceCents:525,ingredientCostCents:20}]},
      quality:{staleInputs:["Latte 12 oz:ingredient_price_freshness_unverified:"+ing]}});
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("returns conflict after any mid-analysis snapshot epoch change",async()=>{
    rpc.mockResolvedValueOnce({status:"available",snapshot});
    rpc.mockResolvedValueOnce({status:"available",snapshot:{...snapshot,revision:"101"}});
    const out=await registry.invoke(scope,ALEX_REVIEW_ID,{purpose:"pricing_review",
      selection:{kind:"specific",items:[{productId:id}]}});
    expect(out).toEqual({status:"conflict",value:null,
      reason:"source_revision_changed_or_unavailable"});
  });
  it("simulation invokes reviewed canonical math and cannot write",async()=>{
    const out=await registry.invokeSimulation(scope,ALEX_SIMULATE_ID,{
      purpose:"pricing_simulate",product:{productId:id},
      changes:[{kind:"ingredient_multiplier",ingredientId:ing,multiplierBasisPoints:13000}],
      sellingPrice:{kind:"delta",deltaCents:50},
    },{bindings:[],operands:[]});
    expect(out).toMatchObject({mode:"simulate",status:"partial",
      proposal:null,executedEffects:0,value:{
        persisted:false,ingredientCostDeltaCents:6,priceDeltaCents:50}});
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("rejects forged tenant, currency, request extras and model-authored source context",async()=>{
    expect(await registry.invoke({...scope,businessId:"b0000000-0000-4000-8000-000000000999"},
      ALEX_REVIEW_ID,{purpose:"pricing_review",selection:{kind:"all_active",offset:0,limit:1}}))
      .toMatchObject({status:"unavailable",reason:"unauthorized"});
    expect(await registry.invoke({...scope,identity:{...scope.identity,currency:"EUR"}},
      ALEX_REVIEW_ID,{purpose:"pricing_review",selection:{kind:"all_active",offset:0,limit:1}}))
      .toMatchObject({status:"unavailable"});
    expect(await registry.invoke(scope,ALEX_REVIEW_ID,{purpose:"pricing_review",
      selection:{kind:"all_active",offset:0,limit:1},businessId:cafe}))
      .toMatchObject({status:"unavailable",reason:"invalid_request"});
    expect(await registry.invokeSimulation(scope,ALEX_SIMULATE_ID,{
      purpose:"pricing_simulate",product:{productId:id},changes:[],
    },{bindings:[],operands:[{price:12345}]}))
      .toMatchObject({status:"unavailable",reason:"invalid_source_context"});
  });
  it("missing RPC, tenant mismatch and malformed original snapshots fail closed",async()=>{
    rpc.mockResolvedValueOnce({status:"unavailable",reason:"rpc_not_installed"});
    expect(await registry.invoke(scope,ALEX_REVIEW_ID,{purpose:"pricing_review",
      selection:{kind:"all_active",offset:0,limit:1}}))
      .toMatchObject({status:"unavailable",reason:"rpc_not_installed"});
    rpc.mockResolvedValueOnce({status:"available",snapshot:{...snapshot,
      businessId:"b0000000-0000-4000-8000-000000000999"}});
    expect(await registry.invoke(scope,ALEX_REVIEW_ID,{purpose:"pricing_review",
      selection:{kind:"all_active",offset:0,limit:1}}))
      .toMatchObject({status:"unavailable",reason:"source_scope_mismatch"});
  });
  it("preserves café-local YYYY-MM-DD for prices taking effect TODAY, in read and what-if",async()=>{
    // readSupervisorCafeIdentity provides a date, not an instant. UTC midnight
    // is still the previous day in America/Los_Angeles; cost MUST be today's.
    const dated={...snapshot,sources:{...snapshot.sources,
      ingredientPrices:[
        {...snapshot.sources.ingredientPrices[0],effective_from:"2026-10-15"},
        {...snapshot.sources.ingredientPrices[0],
          id:"a0000000-0000-4000-8000-000000000201",
          effective_from:"2026-10-16",cost_per_base_unit_micros:150000},
        {...snapshot.sources.ingredientPrices[0],
          id:"a0000000-0000-4000-8000-000000000202",
          effective_from:"2026-10-17",cost_per_base_unit_micros:1000000},
      ]}};
    rpc.mockResolvedValue({status:"available",snapshot:dated});
    const cafeLocal={...scope,identity:{...scope.identity,asOf:"2026-10-16"}};
    const read=await registry.invoke(cafeLocal,ALEX_REVIEW_ID,{
      purpose:"pricing_review",selection:{kind:"specific",items:[{productId:id}]}});
    expect(read).toMatchObject({status:"partial",provenance:{asOf:"2026-10-16"},
      value:{items:[{ingredientCostCents:30}]}});
    const simulate=await registry.invokeSimulation(cafeLocal,ALEX_SIMULATE_ID,{
      purpose:"pricing_simulate",product:{productId:id},changes:[
        {kind:"ingredient_multiplier",ingredientId:ing,multiplierBasisPoints:13000}],
    },{bindings:[],operands:[]});
    expect(simulate).toMatchObject({status:"partial",
      provenance:{asOf:"2026-10-16"},value:{before:{ingredientCostCents:30},
        after:{ingredientCostCents:39},ingredientCostDeltaCents:9}});
    expect(rpc).toHaveBeenCalledTimes(4);
  });
  it("accepts explicitly offset timestamps and rejects impossible/ambiguous local dates",async()=>{
    const timestamp={...scope,identity:{...scope.identity,
      asOf:"2026-10-17T00:30:00Z"}};
    const result=await registry.invoke(timestamp,ALEX_REVIEW_ID,{
      purpose:"pricing_review",selection:{kind:"specific",items:[{productId:id}]}});
    expect(result).toMatchObject({status:"partial",provenance:{asOf:"2026-10-16"}});
    for(const invalid of ["2026-02-30","2026-10-16T12:00:00","2026-13-16"]){
      const bad={...scope,identity:{...scope.identity,asOf:invalid}};
      const out=await registry.invoke(bad,ALEX_REVIEW_ID,{
        purpose:"pricing_review",selection:{kind:"specific",items:[{productId:id}]}});
      expect(out).toMatchObject({status:"unavailable",reason:"invalid_trusted_clock"});
    }
  });

});
