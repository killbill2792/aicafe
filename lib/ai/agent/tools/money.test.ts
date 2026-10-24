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
  it("uses owner-provided net sales and ingredient percentage with recorded daily costs",async()=>{
    const r=await moneyTools.get_break_even.execute({
      ownerNetSalesCents:1100000,ownerSalesDays:22,ownerIngredientPackagingPercent:20,
    },ctx({getBreakEven:async()=>({available:true,value:{
      dailyCostsToCoverCents:70724,drinksNeededPerDay:80,drinksPerHour:7,
      todayDrinks:null,averageMoneyLeftPerDrinkCents:165,progressPercent:null,
    },quality:{...q,missingInputs:["todayDrinksNotRecorded"]}})}));
    expect(r.ownerComparison).toMatchObject({dailyBreakEvenSalesCents:88405,
      dailyNetSalesCents:50000,dailyShortfallCents:38405});
    expect(r.missing).toContain("processingFeeRateUnknown:estimateExcludesProcessingFees");
    expect(r.numberEstimates).toEqual(expect.arrayContaining([
      expect.objectContaining({value:88405,unit:"cents"}),
    ]));
  });
  it("falls back to recorded monthly fixed costs when POS sales are missing",async()=>{
    const r=await moneyTools.get_break_even.execute({
      ownerNetSalesCents:1100000,ownerSalesDays:22,ownerIngredientPackagingPercent:20,
    },ctx({
      getBreakEven:async()=>unavailable,
      getBusinessCostSummary:async p=>({
        period:p,knownTotalCents:1626652,completeness:"partial",
        components:{ingredientsCents:0,loadedStaffCents:1000000,cardFeesCents:0,runningCostsCents:626652},
        observed:{ingredients:false,loadedStaff:true,cardFees:false,runningCosts:true},
        missingInputs:["salesNotImported"],estimatedInputs:[],
        coverage:{salesDays:0,laborDays:23,expectedDays:23,missingProductCostCount:0,
          itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
          historicalIngredientCostsProven:false,soldProductIds:[],
          missingProductCostIds:[],estimatedProductCostIds:[],missingFeeDays:23,
          missingOperatingCategories:[]},
      }),
    }));
    expect(r.ownerCostSource).toBe("business_costs");
    expect(r.ownerComparison).toMatchObject({
      dailyFixedCostsCents:70724,dailyBreakEvenSalesCents:88405,
      dailyNetSalesCents:50000,
    });
    expect(r.missing).toContain("processingFeeRateUnknown:estimateExcludesProcessingFees");
  });
  it("rejects incomplete labor and missing operating categories independently from sales",async()=>{
    const input={ownerNetSalesCents:1100000,ownerSalesDays:22,ownerIngredientPackagingPercent:20};
    const make=(laborDays:number,missingOperatingCategories:Array<{code:string;label:string}>)=>
      ctx({getBreakEven:async()=>unavailable,
        getBusinessCostSummary:async p=>({
          period:p,knownTotalCents:1626652,completeness:"partial" as const,
          components:{ingredientsCents:0,loadedStaffCents:1000000,cardFeesCents:0,runningCostsCents:626652},
          observed:{ingredients:false,loadedStaff:true,cardFees:false,runningCosts:true},
          missingInputs:["salesNotImported"],estimatedInputs:[],
          coverage:{salesDays:0,laborDays,expectedDays:23,missingProductCostCount:0,
            itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
            historicalIngredientCostsProven:false,soldProductIds:[],missingProductCostIds:[],
            estimatedProductCostIds:[],missingFeeDays:23,missingOperatingCategories},
        })});
    const partial=await moneyTools.get_break_even.execute(input,make(5,[]));
    expect(partial.ownerComparison).toEqual({
      dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null,
    });
    expect(partial.missing).toContain("laborDaysIncomplete");
    const rent=await moneyTools.get_break_even.execute(input,make(23,[{code:"rent",label:"Rent"}]));
    expect(rent.ownerComparison).toEqual({
      dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null,
    });
    expect(rent.missing).toContain("operatingExpense:rent");
  });
  it("discloses estimated operating expenses and staff tax while excluding variable-cost assumptions",async()=>{
    const result=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:20,ownerProcessingFeePercent:3,
    },ctx({getBreakEven:async()=>unavailable,
      getBusinessCostSummary:async p=>({
        period:p,knownTotalCents:800000,completeness:"partial" as const,
        components:{ingredientsCents:0,loadedStaffCents:500000,cardFeesCents:0,runningCostsCents:300000},
        observed:{ingredients:false,loadedStaff:true,cardFees:false,runningCosts:true},
        missingInputs:["salesNotImported"],estimatedInputs:[
          "expense:rent","staffTax:2026-10-05","productCost:p1","cardFees:2026-10-05"],
        coverage:{salesDays:0,laborDays:23,expectedDays:23,missingProductCostCount:1,
          itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:1,
          historicalIngredientCostsProven:false,soldProductIds:[],missingProductCostIds:[],
          estimatedProductCostIds:["p1"],missingFeeDays:0,missingOperatingCategories:[]},
      })}));
    expect(result.ownerComparison).toBeDefined();
    expect(result.estimated).toEqual(["expense:rent","staffTax:2026-10-05"]);
    expect(result.missing).not.toContain("operatingExpense:rent");
  });
  it("includes an owner-supplied 3% processing fee without double-counting it",async()=>{
    const r=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:20,ownerProcessingFeePercent:3,
    },ctx({getBreakEven:async()=>({available:true,
      value:{dailyCostsToCoverCents:10000,drinksNeededPerDay:10,drinksPerHour:2,
        todayDrinks:null,averageMoneyLeftPerDrinkCents:100,progressPercent:null},
      quality:q})}));
    expect(r.ownerComparison).toMatchObject({
      dailyBreakEvenSalesCents:12988,contributionBps:7700,
      processingFeeBps:300,processingFeesIncluded:true,
    });
    expect(r.missing).toEqual([]);
  });
  it("does not report complete when contribution is nonpositive or owner's sales days are absent",async()=>{
    const context=ctx({getBreakEven:async()=>({available:true,value:{
      dailyCostsToCoverCents:10000,drinksNeededPerDay:10,drinksPerHour:2,
      todayDrinks:8,averageMoneyLeftPerDrinkCents:100,progressPercent:80,
    },quality:q})});
    const invalid=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:97,ownerProcessingFeePercent:4,
    },context);
    expect(invalid.ownerComparison).toEqual({
      dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null,
    });
    expect(invalid.missing).toContain("invalidContributionMargin");
    const salesWithoutDays=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:20,ownerNetSalesCents:1100000,
      ownerProcessingFeePercent:3,
    },context);
    expect(salesWithoutDays.ownerComparison).toBeDefined();
    expect(salesWithoutDays.missing).toContain("ownerSalesDaysMissing");
    const salesWithoutRate=await moneyTools.get_break_even.execute({
      ownerNetSalesCents:1100000,ownerSalesDays:22,
    },context);
    expect(salesWithoutRate.missing).toContain("ownerIngredientPackagingRateMissing");
  });
  it("invalid contribution invalidates all previous owner comparison metrics",async()=>{
    const result=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:97,ownerProcessingFeePercent:4,
    },ctx({getBreakEven:async()=>({available:true,value:{
      dailyCostsToCoverCents:10000,drinksNeededPerDay:10,drinksPerHour:2,
      todayDrinks:null,averageMoneyLeftPerDrinkCents:100,progressPercent:null,
    },quality:q})}));
    expect(result.missing).toContain("invalidContributionMargin");
    expect(result.ownerComparison).toEqual({
      dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null,
    });
    expect(result.numberEstimates).toBeUndefined();
  });
  it("does not trust partially recorded legacy fixed costs",async()=>{
    const result=await moneyTools.get_break_even.execute({
      ownerIngredientPackagingPercent:20,
    },ctx({getBreakEven:async()=>({available:true,value:{
      dailyCostsToCoverCents:10000,drinksNeededPerDay:10,drinksPerHour:2,
      todayDrinks:null,averageMoneyLeftPerDrinkCents:100,progressPercent:null,
    },quality:{...q,missingInputs:["laborCoverage:5/23"]}})}));
    expect(result.ownerComparison).toMatchObject({
      dailyFixedCostsCents:null,dailyBreakEvenSalesCents:null,dailyShortfallCents:null,
    });
    expect(result.missing).toContain("laborCoverage:5/23");
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
