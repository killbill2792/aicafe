import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { p1ReadCapabilities,p1Analyses,validateP1Analyses,
  executeP1AnalysisAuthorized,discoverP1Analyses } from "./p1Analyses.server";
const identity={asOf:"2026-10-03",timezone:"America/Los_Angeles",businessId:"cafe-a"};
const inv=(id:"alex.pricing.review.v1"|"maya.supplies.quote_evidence.v1"|
 "leo.money.costs.v1"|"olivia.availability.foundation.v1",
 key:string,purpose:string,input:Record<string,unknown>)=>({
  analysisId:id,analysisVersion:1,boundCapabilityKey:key,selectedPurpose:purpose,input,
});
const high={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const profitPeriod={from:"2026-10-01",to:"2026-10-03"};
const costSummary={
  period:profitPeriod,knownTotalCents:400,completeness:"partial" as const,
  components:{ingredientsCents:400,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
  observed:{ingredients:true,loadedStaff:false,cardFees:false,runningCosts:false},
  missingInputs:["laborCoverage:0/3"],estimatedInputs:[],
  coverage:{salesDays:1,laborDays:0,expectedDays:3,missingProductCostCount:0,
    itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
    historicalIngredientCostsProven:false,soldProductIds:[],missingProductCostIds:[],
    estimatedProductCostIds:[],missingFeeDays:0,missingOperatingCategories:[]},
};
describe("P1 analysis-to-typed-read binding",()=>{
  it("pins mode, exact contract schemas, versions, nonempty purposes and source policies",()=>{
    expect(validateP1Analyses()).toBe(true);
    const published=discoverP1Analyses();
    expect(published).toHaveLength(Object.keys(p1ReadCapabilities).length);
    for(const def of Object.values(p1Analyses)){
      const cap=p1ReadCapabilities[def.boundCapabilityKey];
      expect(def.inputSchema).toBe(cap.inputSchema);
      expect(def.outputSchema).toBe(cap.outputSchema);
      expect(def.boundCapabilityMode).toBe("read");
      expect(def.schemaContract.version).toBe(1);
      expect(def.schemaContract.inputSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(def.schemaContract.outputSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(def.sourceRequirementsByPurpose).sort()).toEqual([...def.allowedPurposes].sort());
      expect(def.resourceLimits.maxOperations).toBe(1);
    }
    expect(JSON.stringify(published)).not.toContain("execute");
  });
  it("does not accept free-text purpose, other binding, extra SQL, or mutable purpose mismatch",async()=>{
    const tool=vi.fn();
    const call=inv("leo.money.costs.v1","money.business_costs","actual_period_cost_review",{
      id:"money.business_costs",version:1,purpose:"actual_period_cost_review",period:profitPeriod,
    });
    const tools={getBusinessCostSummary:tool} as unknown as BusinessScopedCafeTools;
    for(const bad of [
      {...call,selectedPurpose:"labor_forecast"},
      {...call,boundCapabilityKey:"money.profitability"},
      {...call,input:{...call.input,purpose:"actual_period_total_costs"}},
      {...call,input:{...call.input,where:"1=1"}},
      {...call,input:{...call.input,businessId:"other-cafe"}},
      {...call,analysisVersion:2},
      {...call,approve:true},
    ]){
      const result=await executeP1AnalysisAuthorized(tools,identity,bad);
      expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_analysis_invocation"});
    }
    expect(tool).not.toHaveBeenCalled();
  });
  it("executes the exact canonical read and respects missing/partial cost evidence",async()=>{
    const tool=vi.fn(async()=>costSummary);
    const read=inv("leo.money.costs.v1","money.business_costs","actual_period_cost_review",{
      id:"money.business_costs",version:1,purpose:"actual_period_cost_review",period:profitPeriod,
    });
    const result=await executeP1AnalysisAuthorized(
      {getBusinessCostSummary:tool} as unknown as BusinessScopedCafeTools,identity,read);
    expect(result).toMatchObject({status:"partial",value:{knownTotalCents:400}});
    expect(tool).toHaveBeenCalledWith(profitPeriod);
    const unknown=await executeP1AnalysisAuthorized(
      {getBusinessCostSummary:vi.fn(async()=>({
        ...costSummary,completeness:"unavailable",knownTotalCents:0,
        observed:{ingredients:false,loadedStaff:false,cardFees:false,runningCosts:false},
      }))} as unknown as BusinessScopedCafeTools,identity,read);
    expect(unknown).toEqual({status:"unavailable",value:null,reason:"unavailable_source"});
  });
  it("fails if a source purpose policy has an extra key, missing key or switched handler",()=>{
    const def=p1Analyses["leo.money.costs.v1"];
    const policies=def.sourceRequirementsByPurpose as Record<string,unknown>;
    policies.rogue={kind:"no_external_sources",inputs:[]};
    expect(validateP1Analyses()).toBe(false);
    delete policies.rogue;
    const old=policies.actual_period_cost_review;
    delete policies.actual_period_cost_review;
    expect(validateP1Analyses()).toBe(false);
    policies.actual_period_cost_review=old;
    expect(validateP1Analyses()).toBe(true);
  });
  it("rejects unknown analysis without calling a capability",async()=>{
    const tools={getBusinessCostSummary:vi.fn()} as unknown as BusinessScopedCafeTools;
    const r=await executeP1AnalysisAuthorized(tools,identity,{
      analysisId:"sneaky.commit.v1",analysisVersion:1,boundCapabilityKey:"money.business_costs",
      selectedPurpose:"actual_period_cost_review",
      input:{id:"money.business_costs",version:1,purpose:"actual_period_cost_review",period:profitPeriod},
    });
    expect(r).toEqual({status:"unavailable",value:null,reason:"unknown_analysis"});
    expect(tools.getBusinessCostSummary).not.toHaveBeenCalled();
  });
});
