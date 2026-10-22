import { describe,expect,it } from "vitest";
import { moneyTools } from "./money";
import type { AgentToolContext } from "./index";
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const unavailable={available:false as const,value:null,quality:{...q,missingInputs:["missingSource"]}};
function ctx(extra:Partial<AgentToolContext["tools"]>):AgentToolContext{
  return {asOf:"2026-10-22",locale:"en",tools:{
    getProfitability:async()=>unavailable,getSalesTrend:async()=>unavailable,
    getMenuCatalog:async()=>unavailable,...extra}};
}
describe("Leo scoped money reads",()=>{
  it("does not call recurring bills recorded expenses",async()=>{
    const r=await moneyTools.get_expenses.execute({period:"month"},ctx({
      getRecordedExpenses:async()=>({available:true,value:{totalCents:2500},quality:q}),
      getExpenseSummary:async()=>({available:true,value:[
        {label:"Rent",categoryCode:"rent",amountCents:45000,isEstimate:true,isMissing:false}],quality:q}),
    }));
    expect(r.recordedActualTotalCents).toBe(2500);
    expect(r.categories).toHaveLength(1);
    expect(r.agentId).toBe("leo");
  });
  it("represents unknown bills as null",async()=>{
    const r=await moneyTools.get_bills.execute({},ctx({getMonthlyBills:async()=>unavailable}));
    expect(r.monthlyEquivalentCents).toBeNull();
  });
  it("preserves unavailable break-even",async()=>{
    const r=await moneyTools.get_break_even.execute({},ctx({getBreakEven:async()=>unavailable}));
    expect(r.estimate).toBeNull();
  });
  it("reports unobserved cost components as null instead of confirmed zero",async()=>{
    const result=await moneyTools.get_cost_summary.execute({period:"month"},ctx({
      getBusinessCostSummary:async p=>({
        period:p,knownTotalCents:10000,completeness:"partial",
        components:{ingredientsCents:10000,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
        observed:{ingredients:true,loadedStaff:false,cardFees:false,runningCosts:false},
        missingInputs:["staffCostsUnobserved"],estimatedInputs:[],
        coverage:{salesDays:2,laborDays:0,expectedDays:22,missingProductCostCount:0,
          itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
          historicalIngredientCostsProven:false,soldProductIds:[],
          missingProductCostIds:[],estimatedProductCostIds:[],missingFeeDays:2,
          missingOperatingCategories:[]},
      }),
    }));
    expect(result.components).toEqual({
      ingredientsCents:10000,loadedStaffCents:null,cardFeesCents:null,runningCostsCents:null,
    });
    expect(result.missing).toContain("staffCostsUnobserved");
  });
  it("rejects input containing a business id",async()=>{
    await expect(moneyTools.get_bills.execute({businessId:"other"},ctx({}))).rejects.toThrow();
  });
});
