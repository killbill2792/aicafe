import {describe,expect,it} from "vitest";
import {moneyTools,INGREDIENT_PERCENT_FACT} from "./money";
import type {AgentToolContext} from "./index";
import type {BusinessCostSummary} from "@/lib/operating/types";
import {classifyNeedsAsk} from "@/lib/ownerFacts/needsAsk";
import {questionFromReasons} from "@/lib/ownerFacts/questions";
import type {SavedFact} from "@/lib/ownerFacts/inject";

const unavailable={available:false as const,value:null,quality:{level:"high" as const,
  missingInputs:["missingSource"],estimatedInputs:[],staleInputs:[]}};
const summary=(p:{from:string;to:string}):BusinessCostSummary=>({
  period:p,knownTotalCents:50000,completeness:"partial",
  components:{ingredientsCents:4000,loadedStaffCents:30000,cardFeesCents:2000,runningCostsCents:14000},
  observed:{ingredients:true,loadedStaff:true,cardFees:true,runningCosts:true},
  missingInputs:["productCost:latte","productCost:mocha","productCost:tea","historicalIngredientCostCoverage"],
  estimatedInputs:[],
  coverage:{salesDays:1,laborDays:1,expectedDays:1,missingProductCostCount:3,itemSalesCovered:true,
    soldProductCount:5,estimatedProductCostCount:0,historicalIngredientCostsProven:false,
    soldProductIds:[],missingProductCostIds:["latte","mocha","tea"],estimatedProductCostIds:[],
    missingFeeDays:0,missingOperatingCategories:[],coveredNetSalesCents:100000},
});
function ctx(facts:SavedFact[]=[]):AgentToolContext{
  return {asOf:"2026-10-30",timezone:"America/Los_Angeles",locale:"en",
    savedOwnerFacts:facts,
    tools:{getProfitability:async()=>unavailable,getSalesTrend:async()=>unavailable,
      getMenuCatalog:async()=>unavailable,getBusinessCostSummary:async p=>summary(p)}} as AgentToolContext;
}
const yesterday={period:{from:"2026-10-29",to:"2026-10-29"}};

describe("get_cost_summary with missing recipe costs",()=>{
  it("asks one café-wide percentage question instead of one per item",async()=>{
    const result=await moneyTools.get_cost_summary.execute(yesterday,ctx());
    expect(result.missing).toEqual([INGREDIENT_PERCENT_FACT]);
    const card=questionFromReasons(classifyNeedsAsk([result],"",""),[result],"","en",[]);
    expect(card?.fields).toEqual([expect.objectContaining({key:INGREDIENT_PERCENT_FACT,inputType:"percent"})]);
  });
  it("uses the owner's 20% from this turn and stops asking",async()=>{
    const result=await moneyTools.get_cost_summary.execute({...yesterday,ownerIngredientPercent:20},ctx());
    expect(result.missing).toEqual([]);
    expect(result.ownerIngredientEstimate).toMatchObject({ingredientPercent:20,
      ingredientsCents:20000,knownTotalWithEstimateCents:66000});
    expect(result.knownTotalCents).toBe(50000);
    expect(result.estimated).toContain("ownerIngredientPercent");
    expect(questionFromReasons(classifyNeedsAsk([result],"",""),[result],"","en",[])).toBeNull();
  });
  it("reuses a saved percentage on later turns",async()=>{
    const facts=[{fact_key:INGREDIENT_PERCENT_FACT,value_json:20,created_at:"2026-10-30T10:00:00Z",
      unit:"percent",period_scope:null}];
    const result=await moneyTools.get_cost_summary.execute(yesterday,ctx(facts));
    expect(result.missing).toEqual([]);
    expect(result.ownerIngredientEstimate).toMatchObject({ingredientsCents:20000});
  });
});
