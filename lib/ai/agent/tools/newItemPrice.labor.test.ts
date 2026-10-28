import {describe,expect,it,vi} from "vitest";
import type {AgentToolContext} from "./index";
import {figure} from "@/lib/calc/supervisorEconomics";

vi.mock("./coverage",()=>({
  resolveCoveredSalesWindow:async()=>({
    period:{from:"2026-10-01",to:"2026-10-22"},label:null,
  }),
}));
import {newItemPriceTools} from "./newItemPrice";

const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const input={ingredient_cost_cents:100,category:"drink" as const,
  packaging_cents:0,target_margin_percent:20,item_name:"Tea",ownerInputs:null};
function context(wageStatus:"missing"|"actual"):AgentToolContext{
  const day={date:"2026-10-22",wagesCents:1200,staffTaxCents:144,
    loadedStaffCostCents:1344,wageStatus};
  return {asOf:"2026-10-22",locale:"en",timezone:"America/Los_Angeles",
    tools:{
      getLaborMetrics:async()=>({available:true,value:[day],quality:q}),
      getProductSales:async()=>({available:true,
        value:[{id:"tea",name:"Tea",category:"drink",units:10}],quality:q}),
      getMonthlyBills:async()=>({available:true,value:{totalCents:10000},quality:q}),
      getMenuCatalog:async()=>({available:true,value:[],quality:q}),
    },
  } as unknown as AgentToolContext;
}
describe("new-item pricing labor status",()=>{
  it("uses owner labor and a covered sales average for a labeled known-cost floor",async()=>{
   const days=Array.from({length:14},(_,i)=>new Date(Date.UTC(2026,7,22+i)).toISOString().slice(0,10));
   const ctx={...context("missing"),asOf:"2026-10-27",
    readEconomics:async()=>({economics:{
      monthlyStaff:figure(null,"missing","Missing"),
      monthlyBills:figure(null,"missing","Overhead missing"),
      feeRate:0,targetMargin:.2,monthlyUnits:null,
    }}),
    tools:{...context("missing").tools,
      getSalesTrend:async()=>({available:true,
        value:days.map(date=>({date,drinksCount:20,ordersCount:12})),
        quality:q})},
   } as unknown as AgentToolContext;
   const result=await newItemPriceTools.suggest_new_item_price.execute({
    ...input,ownerInputs:{netSalesCents:null,salesPeriod:null,laborCents:310000,laborPeriod:{unit:"month"},
     rentCents:null,otherOverheadCents:null,overheadPeriod:null,unitCostCents:null,itemsSoldPerDay:null}
   },ctx);
   expect(result.monthlyLabor).toMatchObject({valueCents:310000,status:"owner",reason:"You told me"});
   expect(result.monthlyUnits).toBe(620);
   expect(result.coverageLabel).toContain("Aug 22–Sep 4");
   expect(result.coverageLabel).toContain("2026");
   expect(result.missing).toContain("overheadPerUnit");
   expect(result.knownCostFloorCents).toBe(600);
   expect(result.recommendedPriceCents).toBeNull();
  });
  it("labels absent packaging as missing and shows a floor, not a recommendation",async()=>{
   const result=await newItemPriceTools.suggest_new_item_price.execute(
    {...input,packaging_cents:null},context("actual"));
   expect(result.missing).toContain("packagingCents");
   expect(result.suggestedPriceCents).toBeNull();
   expect(result.fullCostCents).toBeNull();
   expect(result.costPlusPriceCents).toBeNull();
   expect((result.result as {value:number|null}).value).toBeNull();
   expect(result.knownCostFloorCents).toBeGreaterThan(0);
   expect(result.pricingNote).toContain("floor from known costs, not a recommendation");
   expect(result.explain).toEqual([]);
  });
  it("rejects non-null known-only missing wages without rejecting complete wages",async()=>{
    const partial=await newItemPriceTools.suggest_new_item_price.execute(input,context("missing"));
    expect(partial.missing).toContain("labor30d");
    expect(partial.fullCostCents).toBeNull();
    expect(partial.labor30dCents).toBeNull();
    const complete=await newItemPriceTools.suggest_new_item_price.execute(input,context("actual"));
    expect(complete.labor30dCents).toBe(1344);
    expect(complete.fullCostCents).not.toBeNull();
  });
});
