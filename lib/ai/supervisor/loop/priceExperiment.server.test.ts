import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
const auth=vi.hoisted(()=>({businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",currency:"EUR"}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>auth.businessId}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
 auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
 from:(table:string)=>{
  const filters={eq:()=>filters,maybeSingle:async()=>({data:table==="memberships"?{role:"owner"}:
    {currency:auth.currency,is_demo:false}})};
  return {select:()=>filters};
 },
})}));
vi.mock("./sales.server",()=>({readPriceExperimentBaselineUnits:vi.fn(async()=>70),
 readPriceExperimentSalesDays:vi.fn(async()=>[])}));
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {priceExperimentCapability} from "./priceExperiment.server";
const productId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const scope={businessId:auth.businessId,ownerUserId:"owner",threadId:"thread",locale:"en" as const};
beforeEach(()=>{
 vi.clearAllMocks();auth.currency="EUR";
 vi.mocked(getMenuControlCenter).mockResolvedValue([{
  id:productId,name:"Latte",priceCents:500,pricing:{productCostCents:125},active:true,
 }] as never);
});
describe("owner-agreed N-day price experiment duration",()=>{
 it("preserves an explicit ten-day owner choice from proposal to monitor",async()=>{
  const result=await priceExperimentCapability.simulate(scope,{
   productId,increaseCents:10,days:10});
  expect(result.monitorSpec).toEqual({durationDays:10,metricScope:productId});
  expect(result.effect).toMatchObject({durationDays:10,newPriceCents:510});
  expect(priceExperimentCapability.parseEffect(result.effect)).toMatchObject({
   durationDays:10});
  expect(result.baseline).toMatchObject({source:"daily_rollups+order_lines",
   assumption:"unchanged_unit_demand"});
 });
 it("keeps old approved drafts on the original seven-day default",async()=>{
  const result=await priceExperimentCapability.simulate(scope,{productId,increaseCents:10});
  expect(result.monitorSpec.durationDays).toBe(7);
  expect(result.effect).toMatchObject({durationDays:7});
 });
 it("does not present unequal seven-day baseline comparisons as N-day measured lift",async()=>{
  const {effect}=await priceExperimentCapability.simulate(scope,{
   productId,increaseCents:10,days:10});
  const samples=Array.from({length:10},(_,i)=>({
   businessDate:new Date(Date.UTC(2026,10,1+i)).toISOString().slice(0,10),
   observation:{units:20,netSalesCents:10200,coverage:"actual"},source:"order_lines",
  }));
  const report=await priceExperimentCapability.report(scope,effect,samples,true);
  expect(report.status).toBe("complete");
  expect(report.recommendation).toBe("adjust");
  expect(report.result).toMatchObject({trialDurationDays:10,
   revenueChangeVsBaselineCents:null,
   ingredientContributionChangeVsBaselineCents:null});
 });
 it("rejects invalid, overlong and fractional durations rather than silently substituting seven",async()=>{
  for(const days of [0,91,1.5,-1]){
   await expect(priceExperimentCapability.simulate(scope,{productId,increaseCents:10,days}))
    .rejects.toThrow();
  }
 });
});
