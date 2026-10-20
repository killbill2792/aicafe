import {describe,expect,it} from "vitest";
import {evaluatePriceExperiment,simulatePriceExperiment,priceExperimentEstimatedUplift} from "./priceExperiment";
const base=simulatePriceExperiment({productId:"latte",productName:"Latte",currentPriceCents:500,
  increaseCents:10,ingredientCostCents:125,units7Days:70})!;
describe("price experiment: canonical integer-cent scenarios",()=>{
  it("projects conditional unchanged-volume contribution, not invented profit",()=>{
    expect(base.beforeContributionCents).toBe(375);
    expect(base.afterContributionCents).toBe(385);
    expect(base.estimatedAdditionalRevenue7DaysCents).toBe(700);
    expect(priceExperimentEstimatedUplift(base)).toBe(700);
    expect(base.estimateKind).toBe("conditional_unchanged_demand");
  });
  it("compares seven observed days without treating change as causal profit",()=>{
    const rows=Array.from({length:7},(_,i)=>({businessDate:`2026-10-${String(i+1).padStart(2,"0")}`,
      units:10,netSalesCents:5100,coverage:"actual" as const,source:"orders"}));
    expect(evaluatePriceExperiment(base,rows)).toMatchObject({
      status:"complete",coveredDays:7,units:70,observedRevenueCents:35700,
      realizedRevenueDifferenceCents:700,expectedUpliftAtObservedVolumeCents:700,
      observedIngredientContributionCents:26950,recommendation:"keep"});
  });
  it("never zero-fills missing actual source days",()=>{
    expect(evaluatePriceExperiment(base,[{businessDate:"2026-10-01",units:0,
      netSalesCents:0,coverage:"unavailable",source:"unknown"}])).toMatchObject({
      status:"insufficient_evidence",observedRevenueCents:null});
  });
  it("distinguishes an observed zero day from missing",()=>{
    expect(evaluatePriceExperiment(base,[{businessDate:"2026-10-01",units:0,
      netSalesCents:0,coverage:"actual",source:"rollup"}])).toMatchObject({
      status:"in_progress",observedRevenueCents:0,units:0});
  });
  it("rejects impossible cent/volume inputs",()=>{
    expect(simulatePriceExperiment({productId:"x",productName:"X",currentPriceCents:500,
      increaseCents:0.1,ingredientCostCents:5,units7Days:10})).toBeNull();
  });
});