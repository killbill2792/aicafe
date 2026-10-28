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
 timezone:"America/Los_Angeles",asOf:"2026-10-27",locale:"en",
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
  expect(result.pricingNote).toContain("drink cost");
  expect(result.numberEstimates).toEqual(expect.arrayContaining([
   {value:6000,unit:"count",detail:"pricing"}]));
  expect(result.explain).toEqual(expect.arrayContaining([
   expect.objectContaining({label:"Labor/drink",provenance:"missing"})]));
 });
  it("sparse 3/20 payroll still prices the item with localized caveat in ES/AR",async()=>{
    const dates=Array.from({length:20},(_,i)=>({date:"2026-10-"+String(i+1).padStart(2,"0")}));
    const records=dates.slice(0,3).map(d=>({...d,wagesCents:10000,staffTaxCents:1200,
      laborWageStatus:"actual" as const,staffTaxStatus:"actual" as const}));
    const sparse:Economics={...economics,monthlyStaff:figure(null,"missing","laborNoCoveredDays"),
      laborEvidence:{dates,records},laborCoveredDays:3,laborWindowDays:20};
    for(const locale of ["en","es","ar"] as const){
      const reply=await newItemPriceTools.suggest_new_item_price.execute(input,
        {...context(sparse),locale});
      expect(reply.monthlyLabor.valueCents).toBe(224000);
      expect(reply.monthlyLabor.reasonKey).toBe("laborPartialCoverage");
      expect(reply.monthlyLabor.reason).toContain(locale==="es"?"Nómina":locale==="ar"?"الرواتب":"Payroll");
      expect(reply.breakEvenCents).toBeGreaterThan(0);
      expect(reply.recommendedPriceCents).toBeGreaterThan(0);
      if(locale!=="en")expect(reply.monthlyLabor.reason).not.toContain("Only");
    }
  });
});
