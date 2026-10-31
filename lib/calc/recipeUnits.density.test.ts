import {describe,it,expect} from "vitest";
import {toBaseUnitQuantity,densityFromStoredRecipe,reexpressRecipeQuantity,replacementRecipeLine} from "./recipeUnits";
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
 it("switching milliliters to fluid ounces preserves canonical milk cost",()=>{
  const ounces=reexpressRecipeQuantity("ml","fl_oz",180,"ml");
  expect(ounces).toBeCloseTo(6.08652,4);
  expect(toBaseUnitQuantity("fl_oz",ounces!,"ml")).toBeCloseTo(180,7);
  const cost=draftRecipeCosts([{ingredientId:"milk",baseUnit:"ml",originalBaseQuantity:180,
   costCents:36,displayUnit:"fl_oz",displayQuantity:ounces!,removed:false,conversions:[]}]);
  expect(cost.costCents).toBeCloseTo(36,6);
 });
 it("switches calibrated syrup pumps to fluid ounces without changing cost",()=>{
  const conversions=[{unit:"pump" as const,baseUnitsPerUnit:7.393375}];
  const oz=reexpressRecipeQuantity("pump","fl_oz",3,"ml",conversions);
  expect(oz).toBeCloseTo(.75,4);
  expect(toBaseUnitQuantity("fl_oz",oz!,"ml")).toBeCloseTo(22.180125,4);
  expect(reexpressRecipeQuantity("ml","pump",22.180125,"ml",conversions)).toBeCloseTo(3,6);
 });
 it("does not reinterpret unconfigured shots or unknown weight/volume",()=>{
  expect(reexpressRecipeQuantity("ml","pump",180,"ml")).toBeNull();
  expect(reexpressRecipeQuantity("ml","g",180,"ml")).toBeNull();
  expect(reexpressRecipeQuantity("ml","g",180,"ml",[],1.03)).toBeCloseTo(185.4,6);
 });
 it("returns from milk grams to milliliters using the SOURCE density",()=>{
  const density=densityFromStoredRecipe("ml",100,"g",103);
  expect(density).toBeCloseTo(1.03,9);
  // The destination is the base unit. Density is still needed for source grams.
  const milliliters=reexpressRecipeQuantity("g","ml",103,"ml",[],density!);
  expect(milliliters).toBeCloseTo(100,8);
  expect(toBaseUnitQuantity("ml",milliliters!,"ml")).toBeCloseTo(100,8);
  expect(reexpressRecipeQuantity("ml","g",milliliters!,"ml",[],density!)).toBeCloseTo(103,8);
  expect(reexpressRecipeQuantity("g","ml",103,"ml",[])).toBeNull();
 });
 it("returns a gram-based ingredient from fluid ounces to grams",()=>{
  const density=1.1;
  const ounces=reexpressRecipeQuantity("g","fl_oz",110,"g",[],density);
  const restored=reexpressRecipeQuantity("fl_oz","g",ounces!,"g",[],density);
  expect(restored).toBeCloseTo(110,8);
  expect(reexpressRecipeQuantity("fl_oz","g",ounces!,"g")).toBeNull();
 });
 it("save 103 g / 100 ml recipe -> reopen -> switch default milk without borrowing old milk density",()=>{
  // The owner confirms 1.03 g/ml when writing the original whole-milk recipe.
  const original={ingredientId:"whole-milk",quantity:toBaseUnitQuantity("g",103,"ml",[],1.03)!,
   displayUnit:"g" as const,displayQuantity:103};
  expect(original.quantity).toBeCloseTo(100,9);
  const reopened=JSON.parse(JSON.stringify(original)) as typeof original;
  // The next ingredient has no measured density. The canonical milk volume is
  // retained, and the display falls back to ml instead of inheriting 1.03.
  const replacement=replacementRecipeLine(reopened.quantity,reopened.displayUnit,
    reopened.displayQuantity,"ml","ml",[]);
  expect(replacement).toEqual({quantity:100,displayUnit:"ml",displayQuantity:100});
  const savedAgain=JSON.parse(JSON.stringify({...replacement,ingredientId:"oat-milk"}));
  expect(savedAgain).toEqual({ingredientId:"oat-milk",quantity:100,displayUnit:"ml",displayQuantity:100});
  expect(toBaseUnitQuantity(savedAgain.displayUnit,savedAgain.displayQuantity,"ml")).toBe(100);
 });
 it("preserves each sibling's canonical amount when replacing default milk",()=>{
  const saved=[{q:100,u:"g" as const,d:103},{q:180,u:"ml" as const,d:180},
    {q:240,u:"fl_oz" as const,d:240/29.5735}];
  expect(saved.map(s=>replacementRecipeLine(s.q,s.u,s.d,"ml","ml",[])))
   .toEqual([{quantity:100,displayUnit:"ml",displayQuantity:100},
    {quantity:180,displayUnit:"ml",displayQuantity:180},
    {quantity:240,displayUnit:"fl_oz",displayQuantity:240/29.5735}]);
 });
 it("preserves physical amount across different ingredient pump calibrations, never inheriting the old dose",()=>{
  expect(replacementRecipeLine(30,"pump",3,"ml","ml",[{unit:"pump",baseUnitsPerUnit:5}]))
   .toEqual({quantity:30,displayUnit:"pump",displayQuantity:6});
  expect(replacementRecipeLine(30,"pump",3,"ml","ml",[]))
   .toEqual({quantity:30,displayUnit:"ml",displayQuantity:30});
  // A genuinely cross-base g->ml swap still fails without a real, compatible
  // physical unit or destination calibration; never read 100 g as 100 ml.
  expect(replacementRecipeLine(103,"g",103,"g","ml",[])).toBeNull();
  expect(replacementRecipeLine(103,"ml",100,"g","ml",[]))
   .toEqual({quantity:100,displayUnit:"ml",displayQuantity:100});
 });
 it("rejects invalid densities rather than producing misleading costs",()=>{
  expect(toBaseUnitQuantity("g",120,"ml",[],0)).toBeNull();
  expect(toBaseUnitQuantity("g",120,"ml",[],100)).toBeNull();
  expect(densityFromStoredRecipe("ml",100,"g",1000000)).toBeNull();
 });
});