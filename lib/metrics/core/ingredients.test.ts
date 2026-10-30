import {describe,expect,it} from "vitest";
import {ingredientCostFromSalesShareCents,knownCostsWithIngredientEstimateCents} from "./ingredients";
describe("owner ingredient share",()=>{
  it("takes the share of sales in exact cents, rounding half up",()=>{
    expect(ingredientCostFromSalesShareCents(100000,2000)).toBe(20000);
    expect(ingredientCostFromSalesShareCents(12345,2000)).toBe(2469);
    expect(ingredientCostFromSalesShareCents(25,2000)).toBe(5);
  });
  it("rejects invalid input instead of returning zero",()=>{
    expect(ingredientCostFromSalesShareCents(-1,2000)).toBeNull();
    expect(ingredientCostFromSalesShareCents(100,10000)).toBeNull();
    expect(ingredientCostFromSalesShareCents(10.5,2000)).toBeNull();
  });
  it("swaps the recorded ingredient part for the estimate",()=>{
    expect(knownCostsWithIngredientEstimateCents({knownTotalCents:50000,
      recordedIngredientsCents:4000,estimatedIngredientsCents:20000})).toBe(66000);
    expect(knownCostsWithIngredientEstimateCents({knownTotalCents:100,
      recordedIngredientsCents:200,estimatedIngredientsCents:1})).toBeNull();
  });
});
