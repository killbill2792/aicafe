import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
vi.mock("./sales.server",()=>({
  readPriceExperimentBaselineUnits:vi.fn(),
  readPriceExperimentSalesDays:vi.fn(),
}));
import {priceExperimentCapability} from "./priceExperiment.server";
const scope={businessId:"a0000000-0000-4000-8000-000000000999",
  ownerUserId:"a0000000-0000-4000-8000-000000000998",
  threadId:"a0000000-0000-4000-8000-000000000997",locale:"en" as const};
const effect={productId:"a0000000-0000-4000-8000-000000000001",productName:"Latte",
  oldPriceCents:500,newPriceCents:510,ingredientCostCents:125,
  baselineUnits7Days:70,currency:"USD",estimateKind:"conditional_unchanged_demand"};
const samples=Array.from({length:3},(_,i)=>({
  businessDate:"2026-10-0"+(i+1),source:"order_lines",
  observation:{businessDate:"2026-10-0"+(i+1),units:10,netSalesCents:5100,
    coverage:"actual",source:"order_lines"},
}));
describe("canonical price experiment report delivery status",()=>{
 it("keeps the still-running sample provisional before the observation window ends",async()=>{
  const r=await priceExperimentCapability.report(scope,effect,samples,false);
  expect(r.status).toBe("in_progress");
  expect(r.delivery?.payload.outcomeStatus).toBe("in_progress");
 });
 it("marks terminal incomplete coverage consistently in inbox payload and facts",async()=>{
  const r=await priceExperimentCapability.report(scope,effect,samples,true);
  expect(r.status).toBe("insufficient_evidence");
  expect(r.result.status).toBe("insufficient_evidence");
  expect(r.delivery?.payload.outcomeStatus).toBe("insufficient_evidence");
  expect(r.delivery?.evidence[0]?.facts).toMatchObject({status:"insufficient_evidence",coveredDays:3});
  expect(r.delivery?.confidence).toBe("low");
 });
});
