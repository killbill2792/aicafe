import {describe,it,expect} from "vitest";
import {scenarioTools} from "./scenarios";
import {figure,type Economics} from "@/lib/calc/supervisorEconomics";
import type {AgentToolContext} from "./index";

const base:Economics={
 monthlyBills:figure(746700,"actual","Bills"),
 monthlyStaff:figure(1300000,"owner","Owner confirmed"),
 monthlyRevenue:figure(3000000,"estimate","Projected"),
 ingredientRate:.30,feeRate:.029,ingredientStatus:"owner",feeStatus:"estimate",
 averagePriceCents:500,monthlyUnits:6000,daysInMonth:31,
 targetMargin:.15,missingDays:[],payrollTaxRate:.18,
};
const id="33333333-3333-4333-8333-333333333333";
const drink="22222222-2222-4222-8222-222222222222";
const tools={
 getProfitability:async()=>({available:false as const,value:null,quality:{level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 getSalesTrend:async()=>({available:false as const,value:null,quality:{level:"low" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 getMenuCatalog:async()=>({available:true as const,value:[{id:drink,name:"Latte",category:"drink",active:true,priceCents:2000}],
  quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
 getProductSales:async()=>({available:true as const,value:[{id:drink,name:"Latte",category:"drink" as const,units:100}],quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
};
const read=async()=>({economics:base,ownerMonthlyPayrollCents:1300000,ownerIngredientRate:.30,
 staff:[{id,displayName:"Maria",role:"barista",wageCents:2000,weeklyHours:28}],
 items:[{id:drink,name:"Latte",category:"ESPRESSO_DRINK" as const,currentPriceCents:2000,
  productCostCents:600,productCostStatus:"READY" as const,unitsSoldInWindow:1000}]
});
const context=()=>({asOf:"2026-10-26",locale:"en" as const,tools,readEconomics:read} as unknown as AgentToolContext);
const raw={kind:"bill",itemId:null,staffId:null,role:null,deltaCents:50000,newValueCents:null,
 changePercent:null,hours:null,shiftsPerWeek:null,targetMargin:null};
describe("scoped read-only supervisor scenario tool",()=>{
 it("returns a 500-dollar rent increase without creating any approval card",async()=>{
  const result=await scenarioTools.simulate_scenario.execute(raw,context());
  expect(result).toMatchObject({source:"scenario",status:"estimate",weeklyChangeCents:0,
    difference:{monthlyProfitCents:-50000}});
  expect(result).not.toHaveProperty("proposalId");
 });
 it("uses saved payroll taxes for a six-hour shorter shift",async()=>{
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"shift",
    staffId:id,deltaCents:null,hours:-6,shiftsPerWeek:1},context());
  expect(result.weeklyChangeCents).toBe(Math.round(6*2000*1.18));
 });
 it("rejects missing staff wage instead of pretending a zero wage",async()=>{
  const original=await read();
  const ctx={...context(),readEconomics:async()=>({...original,
    staff:[{...original.staff[0],wageCents:null}]})};
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"shift",
    staffId:id,hours:-6,deltaCents:null},ctx);
  expect(result.missing).toContain("staffWageMissing");
 });
 it("computes 10-cent latte gain against evidenced weekly units",async()=>{
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"item_price",
    itemId:drink,deltaCents:10},context());
  expect(result.weeklyChangeCents).toBe(971);
  expect(result).not.toHaveProperty("proposalId");
 });
 it("returns target-margin goal, not an invented changed break-even",async()=>{
  const result=await scenarioTools.simulate_scenario.execute({...raw,kind:"margin",
    deltaCents:null,targetMargin:.20},context());
  const before=result.before as {monthlyTargetSalesCents:number;monthlyBreakEvenCents:number};
  const after=result.after as {monthlyTargetSalesCents:number;monthlyBreakEvenCents:number};
  expect(after.monthlyTargetSalesCents).toBeGreaterThan(before.monthlyTargetSalesCents);
  expect(after.monthlyBreakEvenCents).toBe(before.monthlyBreakEvenCents);
 });
 it("does not give a fabricated full-profit number with an unknown fee",async()=>{
  const original=await read();
  const result=await scenarioTools.simulate_scenario.execute(raw,{
   ...context(),readEconomics:async()=>({...original,
    economics:{...base,feeRate:null,feeStatus:"missing" as const}})
  });
  expect(result.before).toMatchObject({monthlyProfitCents:null,monthlyBreakEvenCents:null});
 });
});
