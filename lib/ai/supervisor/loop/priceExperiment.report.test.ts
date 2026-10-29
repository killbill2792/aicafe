import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
vi.mock("./sales.server",()=>({
  readPriceExperimentBaselineUnits:vi.fn(),
  readPriceExperimentSalesDays:vi.fn(),
}));
vi.mock("@/lib/data/metricDay.server",()=>({readMetricDay:async(_b:string,date:string)=>({date,
  salesTotalCoverageVerified:true,transactionCountVerified:date!=="2026-09-17",
  facts:{date,netSalesCents:0,ordersCount:date==="2026-10-01"?90:100,drinksCount:0,ingredientsCents:0,wagesCents:0,
    staffTaxCents:0,cardFeesCents:0,voidsCents:0,salesDataStatus:"actual"}})}));
import {priceExperimentCapability} from "./priceExperiment.server";
import {readPriceExperimentSalesDays} from "./sales.server";
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
 it("writes one short mid-run read while running, and none in the final report",async()=>{
  const running=await priceExperimentCapability.report(scope,effect,samples,false);
  // 3 days x 10 at 5.10; baseline at the same volume 30 x 5.00 = 150.00.
  expect(running.midRunText).toBe("Halfway update on Latte: 3 of 7 days counted at $5.10. 30 sold, "+
    "net sales $153.00, $3.00 compared with the old price at the same volume. Early read, not final. "+
    "The full report comes after day 7.");
  const none=await priceExperimentCapability.report(scope,effect,[],false);
  expect(none.midRunText).toContain("no verified sales days yet at $5.10");
  const done=await priceExperimentCapability.report(scope,effect,samples,true);
  expect(done.midRunText).toBeUndefined();
 });
});

describe("price test orders guardrail in the report",()=>{
  const week=(orders:number)=>Array.from({length:7},(_,i)=>({
    businessDate:"2026-10-0"+(i+1),source:"order_lines",
    observation:{businessDate:"2026-10-0"+(i+1),units:10,netSalesCents:5100,coverage:"actual",source:"order_lines",
      cafeOrders:{value:orders,baseline:[{date:"2026-09-2"+(i+1),value:100},{date:"2026-09-1"+(i+1),value:100}]}},
  }));
  it("keeps a good test when café orders held",async()=>{
    const r=await priceExperimentCapability.report(scope,effect,week(99),true);
    expect(r.recommendation).toBe("keep");
    expect(r.delivery?.threadText).toContain("Total café orders held: -1% vs the same weekdays before the test (7 of 7 days compared).");
    expect(r.delivery?.payload).toMatchObject({ordersGuardrail:"ok",ordersChangePct:-1});
  });
  it("says how many days were compared, and when orders could not be checked at all",async()=>{
    const partial=week(100).map((x,i)=>i===0?x:{...x,observation:{...x.observation,
      cafeOrders:{...x.observation.cafeOrders,value:null}}});
    const r=await priceExperimentCapability.report(scope,effect,partial,true);
    expect(r.delivery?.threadText).toContain("(1 of 7 days compared)");
    expect(r.delivery?.payload).toMatchObject({ordersComparedDays:1});
    const none=await priceExperimentCapability.report(scope,effect,samples,true);
    expect(none.delivery?.threadText).toContain("Total café orders not checked");
  });
  it("never says keep when café orders fell 10% or more, and warns halfway",async()=>{
    const r=await priceExperimentCapability.report(scope,effect,week(85),true);
    expect(r.recommendation).toBe("adjust");
    expect(r.delivery?.threadText).toContain("Watch out: total café orders were 15% lower than the same weekdays before the test (595 vs 700; 7 of 7 days compared).");
    const running=await priceExperimentCapability.report(scope,effect,week(85).slice(0,4),false);
    expect(running.midRunText).toMatch(/Watch out: total café orders were 15% lower/);
  });
});

describe("price test monitor",()=>{
  it("records café orders for the day and the same weekday one and two weeks before",async()=>{
    vi.mocked(readPriceExperimentSalesDays).mockResolvedValueOnce([{businessDate:"2026-10-01",units:10,
      netSalesCents:5100,coverage:"actual",source:"order_lines"}] as never);
    const s=await priceExperimentCapability.monitor(scope,effect,"2026-10-01");
    expect(s?.observation.cafeOrders).toEqual({value:90,baseline:[{date:"2026-09-24",value:100},{date:"2026-09-17",value:null}]});
  });
});
