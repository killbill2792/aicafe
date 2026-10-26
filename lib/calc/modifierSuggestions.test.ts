import {describe,it,expect} from "vitest";
import {suggestModifierLinks,type RecipeCandidate,type ObservedModifier} from "./modifierSuggestions";
const recipes:RecipeCandidate[]=[
 {id:"oat",name:"Oat Milk",ingredientId:"milk",ingredientName:"Oat milk",unit:"ml",quantityDelta:220},
 {id:"shot",name:"Extra Shot",ingredientId:"coffee",ingredientName:"Espresso",unit:"g",quantityDelta:18}
];
const modifiers:ObservedModifier[]=[
 {provider:"square",locationRef:"loc",posModifierId:"A",name:"Oat Milk"},
 {provider:"toast",locationRef:"rest",posModifierId:"B",name:"Extra Shot"}
];
describe("safe source-agnostic modifier suggestions",()=>{
 it("matches oat milk and espresso shots when there is one candidate",()=>{
  expect(suggestModifierLinks(modifiers,recipes,new Set()).map(r=>r.recipeId)).toEqual(["oat","shot"]);
 });
 it("fails closed on ambiguous recipes",()=>{
  expect(suggestModifierLinks(modifiers,[recipes[0],{...recipes[0],id:"other"}],new Set())).toEqual([]);
 });
 it("scopes mappings by provider and restaurant/location",()=>{
  const key="square:loc:a";
  expect(suggestModifierLinks(modifiers,recipes,new Set([key])).map(r=>r.recipeId)).toEqual(["shot"]);
 });
 it("does not infer modifier amounts for unknown labels",()=>{
  expect(suggestModifierLinks([{...modifiers[0],name:"Oat or almond milk"}],recipes,new Set())).toEqual([]);
 });
});
