import { describe,expect,it } from "vitest";
import { conditionalTargetPrice,ingredientOnlyEconomics,scaleMicrocents,
  supplierPackageMicrocents } from "./alexPricingMath";

describe("Alex ingredient-only integer-cent math",()=>{
  it("converts exact US gallons without treating ounces as grams",()=>{
    expect(supplierPackageMicrocents(400,1,"gal","ml")).toBe(105670);
    expect(supplierPackageMicrocents(400,1,"gal","g")).toBeNull();
    expect(supplierPackageMicrocents(40,1,"fl_oz","ml")).toBe(135256);
    expect(supplierPackageMicrocents(0,1,"gal","ml")).toBe(0);
    expect(supplierPackageMicrocents(-1,1,"gal","ml")).toBeNull();
    expect(supplierPackageMicrocents(400,0,"gal","ml")).toBeNull();
  });
  it("applies exact positive 30% owner-supplied supplier cost multiplier",()=>{
    expect(scaleMicrocents(200000,13000)).toBe(260000);
    expect(scaleMicrocents(200000,0)).toBe(0);
    expect(scaleMicrocents(-1,13000)).toBeNull();
  });
  it("never divides by zero, guesses an industry target, or mislabels profit",()=>{
    expect(ingredientOnlyEconomics(95,525)).toEqual({
      ingredientCostCents:95,costRatioBasisPoints:1810,
      ingredientContributionCents:430,ingredientContributionBasisPoints:8190,
    });
    expect(ingredientOnlyEconomics(0,0)).toMatchObject({
      ingredientCostCents:0,costRatioBasisPoints:null,ingredientContributionBasisPoints:null,
    });
    expect(ingredientOnlyEconomics(95,null)?.ingredientContributionCents).toBeNull();
    expect(conditionalTargetPrice(100,2500)).toBe(400);
    expect(conditionalTargetPrice(100,0)).toBeNull();
    expect(conditionalTargetPrice(0,3000)).toBeNull();
  });
});
