import {describe,expect,it} from "vitest";
import {keepPreview,recipePreviewCost} from "./recipePreview";
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
