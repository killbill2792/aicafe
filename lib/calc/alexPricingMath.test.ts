import { describe,expect,it } from "vitest";
import {ingredientOnlyEconomics} from "./alexPricingMath";

describe("Alex ingredient-only integer-cent math",()=>{
  it("never divides by zero, guesses an industry target, or mislabels profit",()=>{
    expect(ingredientOnlyEconomics(95,525)).toEqual({
      ingredientCostCents:95,costRatioBasisPoints:1810,
      ingredientContributionCents:430,ingredientContributionBasisPoints:8190,
    });
    expect(ingredientOnlyEconomics(0,0)).toMatchObject({
      ingredientCostCents:0,costRatioBasisPoints:null,ingredientContributionBasisPoints:null,
    });
    expect(ingredientOnlyEconomics(95,null)?.ingredientContributionCents).toBeNull();
  });
});
