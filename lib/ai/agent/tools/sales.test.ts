import { describe,expect,it } from "vitest";
import { salesTools } from "./sales";
import type { AgentToolContext } from "./index";
const unavailable={available:false as const,value:null,quality:{level:"low" as const,missingInputs:["notCovered"],estimatedInputs:[],staleInputs:[]}};
function ctx(extra:Partial<AgentToolContext["tools"]>):AgentToolContext{
  return {asOf:"2026-10-22",locale:"en",tools:{
    getProfitability:async()=>unavailable,getSalesTrend:async()=>unavailable,
    getMenuCatalog:async()=>unavailable,...extra}};
}
describe("Alex item sales and deterministic pricing",()=>{
  it("reports no quantities without proven POS coverage",async()=>{
    const r=await salesTools.get_item_sales.execute({period:"week"},ctx({getProductSales:async()=>unavailable}));
    expect(r.items).toBeNull();expect(r.missing).toEqual(["notCovered"]);
  });
  it("retains estimated payroll and operating-cost inputs alongside pricing confidence",async()=>{
    const recommendation={
      productCostCents:125,baselinePriceCents:575,calculatedSuggestedPriceCents:600,
      currentPriceCents:550,recommendedPriceCents:600,calculationMode:"BUSINESS_ADJUSTED" as const,
      businessAdjustmentFactor:1.02,confidence:"HIGH" as const,status:"NEW_PRICE" as const,
      explanationCode:"BUSINESS_ADJUSTED_EXPLAINER" as const,
      assumptions:[],signals:[],explanationInputs:{},warnings:[],
      dataQuality:{level:"medium" as const,missingInputs:[],
        estimatedInputs:["payrollTaxes","operatingCosts"],staleInputs:[]},
    };
    const result=await salesTools.get_price_recommendation.execute({
      itemId:"11111111-1111-4111-8111-111111111111"},ctx({
      getMenuCatalog:async()=>({available:true,value:[{id:"11111111-1111-4111-8111-111111111111",name:"Latte",active:true,category:"drink",priceCents:550}],quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
      getPricingRecommendation:async()=>({available:true,value:recommendation,
        quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
    }));
    expect(result).toMatchObject({confidence:"HIGH",mode:"BUSINESS_ADJUSTED",
      estimated:["payrollTaxes","operatingCosts"],missing:[]});
  });
  it("does not manufacture a recommendation on unavailable pricing",async()=>{
    const r=await salesTools.get_price_recommendation.execute({
      itemId:"11111111-1111-4111-8111-111111111111"},
      ctx({getPricingRecommendation:async()=>unavailable}));
    expect(r.missing).toEqual(["notCovered"]);
    expect(r.recommendedPriceCents).toBeUndefined();
  });
});
