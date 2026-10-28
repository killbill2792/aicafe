import {describe,it,expect} from "vitest";
import type {AgentToolContext} from "./index";
import {newItemPriceTools} from "./newItemPrice";
import {figure} from "@/lib/calc/supervisorEconomics";
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
describe("owner labor with actual covered sales",()=>{
 it("includes owner labor in the floor using Aug 22–Sep 4 daily sales",async()=>{
  const days=Array.from({length:14},(_,i)=>
   new Date(Date.UTC(2026,7,22+i)).toISOString().slice(0,10));
  const ctx={
   asOf:"2026-10-27",timezone:"America/Los_Angeles",locale:"en" as const,
   tools:{getSalesTrend:async({from,to}:{from:string;to:string})=>{
    const selected=days.filter(date=>date>=from&&date<=to);
    return {available:selected.length>0,value:selected.map(date=>({date,drinksCount:20,ordersCount:12})),quality:q};
   }},
   readEconomics:async()=>({economics:{
    monthlyStaff:figure(null,"missing","Missing labor"),
    monthlyBills:figure(null,"missing","Missing overhead"),
    monthlyUnits:null,feeRate:0,targetMargin:.2,
   }}),
  } as unknown as AgentToolContext;
  const result=await newItemPriceTools.suggest_new_item_price.execute({
   ingredient_cost_cents:100,category:"drink",packaging_cents:0,
   item_name:"Tea",ownerInputs:{netSalesCents:null,salesPeriod:null,laborCents:310000,
    laborPeriod:{unit:"month"},rentCents:null,otherOverheadCents:null,
    overheadPeriod:null,unitCostCents:null,itemsSoldPerDay:null}
  },ctx);
  expect(result.monthlyLabor).toMatchObject({valueCents:310000,status:"owner",reason:"laborOwnerProvided"});
  expect(result.monthlyUnits).toBe(620);
  expect(result.coverageLabel).toContain("Aug 22–Sep 4");
  expect(result.coverageLabel).toContain("2026");
  expect(result.missing).toContain("overheadPerUnit");
  expect(result.knownCostFloorCents).toBe(600);
  expect(result.recommendedPriceCents).toBe(350);
 });
});
