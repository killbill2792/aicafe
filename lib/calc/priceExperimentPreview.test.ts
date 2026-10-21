import {describe,it,expect} from "vitest";
import {previewPriceExperiment} from "./priceExperiment";
const input={productId:"a0000000-0000-4000-8000-000000000016",productName:"Latte 16 oz",
 currentPriceCents:700,increaseCents:10,ingredientCostCents:null,units7Days:null};
describe("price experiment preview handles verified gaps without fake sales",()=>{
 it("shows the exact before/after prices without pretending baseline inputs exist",()=>{
  expect(previewPriceExperiment(input)).toEqual({
   effect:{productId:input.productId,productName:"Latte 16 oz",
     oldPriceCents:700,newPriceCents:710},
   baseline:{estimatedAdditionalRevenue7DaysCents:null,
     missingInputs:["ingredient_cost","covered_seven_day_sales"]},
  });
 });
 it("estimates unchanged-demand uplift only from actual seven-day covered units",()=>{
  const r=previewPriceExperiment({...input,units7Days:70,ingredientCostCents:145});
  expect(r?.baseline).toEqual({estimatedAdditionalRevenue7DaysCents:700,missingInputs:[]});
 });
 it("does not fabricate sales when ingredient costs are available",()=>{
  expect(previewPriceExperiment({...input,ingredientCostCents:145})?.baseline)
    .toEqual({estimatedAdditionalRevenue7DaysCents:null,missingInputs:["covered_seven_day_sales"]});
 });
 it("still enforces the exact increase cap and safe arithmetic",()=>{
  expect(previewPriceExperiment({...input,increaseCents:351})).toBeNull();
  expect(previewPriceExperiment({...input,increaseCents:0})).toBeNull();
  expect(previewPriceExperiment({...input,currentPriceCents:Number.MAX_SAFE_INTEGER})).toBeNull();
 });
});
