import {describe,expect,it} from "vitest";
import {keepPreview,recipePreviewCost,draftRecipeCosts} from "./recipePreview";
const espresso={ingredientId:"espresso",quantity:36,displayQuantity:2,costCents:48};
const milk={ingredientId:"milk",quantity:295.735,displayQuantity:10,costCents:39};
describe("all sizes recipe cost preview",()=>{
 it("keeps the same total for footer and margin",()=>{
  const result=recipePreviewCost([espresso,milk],{espresso:3,milk:12});
  expect(result).toEqual({costCents:118.8,estimated:false});
  expect(keepPreview(550,result.costCents)).toEqual({keepCents:431,keepPercent:78});
 });
 it("does not turn an unknown cost into zero",()=>{
  expect(recipePreviewCost([{...milk,costCents:null}],{milk:10})).toEqual({costCents:null,estimated:true});
  expect(keepPreview(550,null)).toEqual({keepCents:null,keepPercent:null});
 });
 it("can remove a line without charging for it",()=>{
  expect(recipePreviewCost([espresso,milk],{espresso:2,milk:0})).toEqual({costCents:48,estimated:false});
 });
 it("keeps zero and a negative customer margin explicit",()=>{
  expect(keepPreview(100,150)).toEqual({keepCents:-50,keepPercent:-50});
 });
});

describe("draft unit conversion and footer cost share a single source",()=>{
 const line={ingredientId:"espresso",originalBaseQuantity:36,baseUnit:"g" as const,
  costCents:48,displayUnit:"shot" as const,displayQuantity:2,
  conversions:[{unit:"shot" as const,baseUnitsPerUnit:18}],removed:false};
 it("switching a 2-shot ingredient to 18 grams halves its cost",()=>{
  const result=draftRecipeCosts([{...line,displayUnit:"g",displayQuantity:18}]);
  expect(result.costCents).toBe(24);
  expect(result.lineCosts.espresso).toBe(result.costCents);
 });
 it("supports 1.5 shots without changing their base-unit price",()=>{
  const result=draftRecipeCosts([{...line,displayQuantity:1.5}]);
  expect(result.costCents).toBe(36);
  expect(keepPreview(550,result.costCents).keepCents).toBe(514);
 });
 it("unknown conversions and costs stay unavailable rather than free",()=>{
  expect(draftRecipeCosts([{...line,conversions:[]}]).costCents).toBeNull();
  expect(draftRecipeCosts([{...line,costCents:null}]).lineCosts.espresso).toBeNull();
 });
 it("removes selected cells without charging them",()=>{
  expect(draftRecipeCosts([{...line,removed:true}])).toEqual({costCents:null,lineCosts:{},estimated:true});
 });
});
