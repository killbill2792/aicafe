import {describe,it,expect} from "vitest";
import {toBaseUnitQuantity,densityFromStoredRecipe} from "./recipeUnits";
import {draftRecipeCosts} from "./recipePreview";
import {suggestedIngredientDensity} from "./suggestedRecipeMeasures";
describe("volume and weight recipe conversions",()=>{
 it("does not guess a density for unknown ingredients",()=>{
  expect(toBaseUnitQuantity("g",120,"ml")).toBeNull();
  expect(suggestedIngredientDensity("Unknown sauce")).toBeNull();
 });
 it("converts milk grams to milliliters and recovers the owner density from saved fields",()=>{
  const density=1.03;
  const base=toBaseUnitQuantity("g",120,"ml",[],density);
  expect(base).toBeCloseTo(116.504854,5);
  const restored=densityFromStoredRecipe("ml",base!,"g",120);
  expect(restored).toBeCloseTo(density,7);
  expect(toBaseUnitQuantity("g",150,"ml",[],restored!)).toBeCloseTo(145.631068,5);
 });
 it("converts liquid volume to mass for gram-based pantry ingredients",()=>{
  const base=toBaseUnitQuantity("fl_oz",2,"g",[],1.03);
  expect(base).toBeCloseTo(60.92141,4);
  expect(densityFromStoredRecipe("g",base!,"fl_oz",2)).toBeCloseTo(1.03,6);
  expect(toBaseUnitQuantity("ml",100,"g",[],1.03)).toBeCloseTo(103,6);
 });
 it("preserves the canonical ingredient cost based on stored base quantity",()=>{
  const preview=draftRecipeCosts([{ingredientId:"milk",baseUnit:"ml",originalBaseQuantity:100,
   costCents:20,displayUnit:"g",displayQuantity:103,removed:false,conversions:[],densityGramsPerMl:1.03}]);
  expect(preview.costCents).toBeCloseTo(20);
  expect(preview.estimated).toBe(false);
 });
 it("rejects invalid densities rather than producing misleading costs",()=>{
  expect(toBaseUnitQuantity("g",120,"ml",[],0)).toBeNull();
  expect(toBaseUnitQuantity("g",120,"ml",[],100)).toBeNull();
  expect(densityFromStoredRecipe("ml",100,"g",1000000)).toBeNull();
 });
});