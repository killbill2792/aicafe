import {describe,it,expect} from "vitest";
import {simulateDrinkPriceExperiment,reportDrinkPriceExperiment,addBusinessDays} from "./priceExperiment";
const baseline=Array.from({length:7},(_,i)=>({businessDate:addBusinessDays("2026-10-01",i),
  units:10,revenueCents:5000,actual:true}));
describe("price experiment canonical cents",()=>{
  it("forecasts fixed-volume impact with true ingredient-only contribution",()=>{
    const result=simulateDrinkPriceExperiment({fromPriceCents:500,deltaCents:10,
      ingredientCostCents:125,baselineDays:baseline});
    expect(result.baseline).toEqual({units:70,revenueCents:35000,ingredientContributionCents:26250});
    expect(result.forecast).toEqual({units:70,revenueCents:35700,ingredientContributionCents:26950});
    expect(result.estimatedDeltaRevenueCents).toBe(700);
    const report=reportDrinkPriceExperiment({simulation:result,days:baseline.map(x=>({
      ...x,revenueCents:5100})),requiredDays:7,windowElapsed:true});
    expect(report.status).toBe("complete");
    expect(report.observed).toEqual({units:70,revenueCents:35700,ingredientContributionCents:26950});
    expect(report.observedVsBaselineContributionCents).toBe(700);
    expect(report.recommendation).toBe("keep");
  });
  it("never substitutes zero for absent coverage and never claims an early report complete",()=>{
    const incomplete=baseline.map((d,i)=>i===2?{...d,actual:false,units:null,revenueCents:null}:d);
    const sim=simulateDrinkPriceExperiment({fromPriceCents:500,deltaCents:10,
      ingredientCostCents:125,baselineDays:incomplete});
    expect(sim.status).toBe("unavailable");
    const all=simulateDrinkPriceExperiment({fromPriceCents:500,deltaCents:10,
      ingredientCostCents:125,baselineDays:baseline});
    const report=reportDrinkPriceExperiment({simulation:all,days:incomplete,
      requiredDays:7,windowElapsed:true});
    expect(report.status).toBe("insufficient_evidence");
    expect(report.recommendation).toBe("unavailable");
    expect(report.observed).toBeNull();
    expect(reportDrinkPriceExperiment({simulation:all,days:baseline,
      requiredDays:7,windowElapsed:false}).recommendation).toBe("unavailable");
  });
});
