import {describe,expect,it} from "vitest";
import {recipeEditorKey} from "./recipeEditorKey";

describe("Pantry recipe draft editor identity",()=>{
 const size={
  id:"size-a",priceCents:525,active:true,
  recipe:[{ingredientId:"whole-milk",quantity:103,displayUnit:"ml",displayQuantity:100}],
 };
 it("does not reset unsaved drafts when only serving status or price changes",()=>{
  const key=recipeEditorKey([size]);
  expect(recipeEditorKey([{...size,active:false}])).toBe(key);
  expect(recipeEditorKey([{...size,priceCents:550}])).toBe(key);
  expect(recipeEditorKey([{...size,active:false,priceCents:550}])).toBe(key);
 });
 it("refreshes the editor identity after a saved recipe itself changes",()=>{
  const key=recipeEditorKey([size]);
  expect(recipeEditorKey([{...size,recipe:[{...size.recipe[0],quantity:110}]}]))
   .not.toBe(key);
  expect(recipeEditorKey([{...size,recipe:[{...size.recipe[0],ingredientId:"water"}]}]))
   .not.toBe(key);
  expect(recipeEditorKey([{...size,recipe:[{...size.recipe[0],displayQuantity:110}]}]))
   .not.toBe(key);
 });
});
