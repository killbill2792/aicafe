import {describe,it,expect} from "vitest";
import {swapCostPerSize,keepFromAddon,chatReadyMilkSwap} from "./modifierPricing";
const sizes=["8oz","12oz","16oz"].map(label=>({id:label,label}));
const ml={ "8oz":{ml:120,basis:"recorded" as const},
  "12oz":{ml:180,basis:"recorded" as const},
  "16oz":{ml:240,basis:"owner_provided" as const} };
const costs={regular:{costPerMlMicros:100_000,basis:"recorded" as const},
  oat:{costPerMlMicros:200_000,basis:"recorded" as const}};
describe("milk swap cost per size",()=>{
  it("returns independent 8/12/16 oz deltas, 5-cent upcharges and kept margin",()=>{
    const result=swapCostPerSize(sizes,"regular","oat",ml,costs,.3,"owner_provided");
    expect(result.missing).toEqual([]);
    expect(result.sizes.map(s=>s.costDeltaCents)).toEqual([12,18,24]);
    expect(result.sizes.map(s=>s.suggestedUpchargeCents)).toEqual([20,30,35]);
    expect(result.sizes.map(s=>s.marginKeptCents)).toEqual([8,12,11]);
    expect(result.sizes[2].basis).toEqual({
      fromMilk:"recorded",toMilk:"recorded",milkMl:"owner_provided",
      targetProductCost:"owner_provided"});
    expect(chatReadyMilkSwap(sizes,"regular","oat",ml,costs).rows).toHaveLength(3);
  });
  it("missing ingredient price or size quantity returns exact missing keys and null money",()=>{
    const outcome=swapCostPerSize(sizes,"regular","oat",
      {...ml,"16oz":{ml:null,basis:"missing" as const}},
      {...costs,oat:{costPerMlMicros:null,basis:"missing" as const}});
    expect(outcome.missing).toEqual(["milk_cost:oat","milk_ml:16oz"]);
    expect(outcome.sizes.every(row=>row.suggestedUpchargeCents===null)).toBe(true);
    expect(outcome.sizes[0].missing).not.toContain("milk_ml:16oz");
  });
  it("retains cost savings and refuses invalid input instead of inventing prices",()=>{
    const cheaper=swapCostPerSize([sizes[0]],"oat","regular",ml,costs,.3).sizes[0];
    expect(cheaper.costDeltaCents).toBe(-12);
    expect(cheaper.suggestedUpchargeCents).toBe(0);
    expect(cheaper.marginKeptCents).toBe(12);
    expect(keepFromAddon(0,24)).toBe(-24);
    const missing=swapCostPerSize([sizes[0]],"regular","oat",ml,costs,null);
    expect(missing.missing).toContain("target_product_cost_percent");
  });
});
