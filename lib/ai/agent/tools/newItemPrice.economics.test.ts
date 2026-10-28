import {describe,expect,it} from "vitest";
import {newItemPriceTools} from "./newItemPrice";
import type {AgentToolContext} from "./index";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
const economics:Economics={
 monthlyBills:figure(746700,"actual","recorded monthly bills"),
 monthlyStaff:figure(600000,"actual","recorded clocked wages"),
 monthlyRevenue:figure(3000000,"estimate","sales projection"),
 ingredientRate:.3,feeRate:.029,ingredientStatus:"actual",feeStatus:"actual",
 averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,targetMargin:.15,missingDays:[],
};
const input={ingredient_cost_cents:145,category:"drink" as const,
 packaging_cents:0,item_name:"New Latte",ownerInputs:null};
const context=(e:Economics):AgentToolContext=>({
 asOf:"2026-10-27",locale:"en",
 tools:{} as AgentToolContext["tools"],
 readEconomics:async()=>({economics:e,items:[],staff:[],
  ownerMonthlyPayrollExtrasCents:null,ownerIngredientRate:null})
} as AgentToolContext);
describe("supervisor new-item price evidence",()=>{
 it("recommends a price only with known labor, overhead, fees and packaging",async()=>{
  const result=await newItemPriceTools.suggest_new_item_price.execute(input,context(economics));
  expect(result.recommendedPriceCents).toBe(500);
  expect(result.breakEvenCents).toBeGreaterThan(0);
  expect(result.knownCostFloorCents).toBeNull();
  expect(result.missing).toEqual([]);
 });
 it("returns an explicitly labeled floor and missing inputs, not a recommendation",async()=>{
  const result=await newItemPriceTools.suggest_new_item_price.execute(
   {...input,packaging_cents:null},
   context({...economics,monthlyStaff:figure(null,"missing","unknown attendance"),feeRate:null,
     feeStatus:"missing"}));
  expect(result.recommendedPriceCents).toBeNull();
  expect(result.fullCostCents).toBeNull();
  expect(result.breakEvenCents).toBeNull();
  expect(result.knownCostFloorCents).toBeGreaterThanOrEqual(145);
  expect(result.knownCostFloorLabel).toBe("floor, not a recommendation");
  expect(result.missing).toEqual(expect.arrayContaining([
   "packagingCents","laborPerUnit","processingFeeRate"]));
  expect(result.pricingNote).toContain("Missing:");
  expect(result.pricingNote).toContain("floor from known costs");
  expect(result.numberEstimates).toEqual([
   {value:result.knownCostFloorCents,unit:"cents",detail:"breakEvenSales"}]);
 });
});
