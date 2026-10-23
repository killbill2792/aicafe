import {describe,it,expect} from "vitest";
import {scopedToastModifierId,scopedToastModifierRecipes,sizedMilkReplacementQuantity} from "./usageModifierResolution";
import {calculateUsage} from "./usageVariance";

describe("restaurant-scoped Toast modifier recipes",()=>{
 const recipeA={id:"recipe-a",ingredientId:"oat",quantityDelta:200,replacesIngredientId:"milk"};
 const recipeB={id:"recipe-b",ingredientId:"soy",quantityDelta:200,replacesIngredientId:"milk"};
 const restaurantA="11111111-1111-4111-8111-111111111111";
 const restaurantB="22222222-2222-4222-8222-222222222222";
 const option="33333333-3333-4333-8333-333333333333";
 it("never lets the same modifier GUID bleed between restaurants",()=>{
  const found=scopedToastModifierRecipes([
   {restaurantGuid:restaurantA,posModifierId:option,recipeId:"recipe-a"},
   {restaurantGuid:restaurantB,posModifierId:option,recipeId:"recipe-b"},
  ],[recipeA,recipeB]);
  const keyA=scopedToastModifierId(restaurantA,option)!;
  const keyB=scopedToastModifierId(restaurantB,option)!;
  expect(found.get(keyA)?.ingredientId).toBe("oat");
  expect(found.get(keyB)?.ingredientId).toBe("soy");
  expect(found.has(scopedToastModifierId("44444444-4444-4444-8444-444444444444",option)!)).toBe(false);
  const sales=[keyA,keyB].map((key,index)=>({menuItemId:"latte",quantity:1,
   businessDate:"2026-10-21",closedAt:"2026-10-21T12:00:00Z",locationId:"loc-"+index,
   modifiers:[{posModifierId:key,name:"Milk swap"}]}));
  const rows=calculateUsage({
   ingredients:[{id:"milk",name:"Milk",unit:"ml" as const},
    {id:"oat",name:"Oat",unit:"ml" as const},{id:"soy",name:"Soy",unit:"ml" as const}],
   recipes:[{menuItemId:"latte",ingredientId:"milk",quantity:200}],
   modifiers:[...found.values()],sales,salesCovered:true,counts:[],purchases:[],
   from:"2026-10-20",to:"2026-10-21"
  });
  expect(rows.map(r=>r.expected)).toEqual([0,200,200]);
 });
 it("rejects conflicting approvals and unsafe bare GUID aliases",()=>{
  const links=[{restaurantGuid:restaurantA,posModifierId:option,recipeId:"recipe-a"},
   {restaurantGuid:restaurantA,posModifierId:option,recipeId:"recipe-b"}];
  const found=scopedToastModifierRecipes(links,[recipeA,recipeB,
   {id:"legacy",ingredientId:"milk",quantityDelta:1,replacesIngredientId:null,posModifierId:option}]);
  expect(found.has(scopedToastModifierId(restaurantA,option)!)).toBe(false);
  expect(found.has(option)).toBe(false);
 });
 it("allows only explicitly scoped, approved legacy identifiers",()=>{
  const key=scopedToastModifierId(restaurantA,option)!;
  const found=scopedToastModifierRecipes([],[{...recipeA,posModifierId:key}]);
  expect(found.get(key)?.ingredientId).toBe("oat");
 });
});
describe("milk swap portions by sold recipe size",()=>{
 const espresso={ingredientId:"espresso",quantity:18};
 it("uses the small and large drink recipes instead of displayQuantity=1",()=>{
  expect(sizedMilkReplacementQuantity([espresso,{ingredientId:"milk",quantity:140}],"milk","ml","ml")).toBe(140);
  expect(sizedMilkReplacementQuantity([espresso,{ingredientId:"milk",quantity:300}],"milk","ml","ml")).toBe(300);
 });
 it("does not guess at missing recipes or density conversions",()=>{
  expect(sizedMilkReplacementQuantity([espresso],"milk","ml","ml")).toBeNull();
  expect(sizedMilkReplacementQuantity([{ingredientId:"milk",quantity:200}],"milk","ml","g")).toBeNull();
  expect(sizedMilkReplacementQuantity([{ingredientId:"milk",quantity:0}],"milk","ml","ml")).toBeNull();
 });
});
