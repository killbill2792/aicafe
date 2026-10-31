import {describe,it,expect} from "vitest";
import {moneyTools} from "./money";
import {executeAgentTool} from "./index";
import type {AgentToolContext} from "./index";

const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
function ctx(monthlyCents:number|null):AgentToolContext{
 return {
  asOf:"2026-06-15",timezone:"America/Los_Angeles",locale:"en",
  tools:{
   getBreakEven:async()=>({available:true,value:{dailyCostsToCoverCents:10000},quality}),
   getOwnerMonthlyPayrollExtras:async()=>({available:true,
    value:{monthlyCents,source:monthlyCents===null?null:"owner_entered" as const},
    quality:monthlyCents===null?
     {...quality,level:"low" as const,missingInputs:["ownerMonthlyPayrollExtrasNotSet"]}:quality}),
  },
 } as unknown as AgentToolContext;
}
const inputs={ownerIngredientPackagingPercent:20,ownerProcessingFeePercent:0,
 ownerNetSalesCents:null,ownerSalesDays:null,ownerInputs:null};
describe("break-even owner payroll evidence",()=>{
 it("never calculates from a legacy payroll extras reader without canonical facts",async()=>{
  const result=await moneyTools.get_break_even.execute(inputs,ctx(3000));
  expect(result.missing).toContain("canonicalBreakEvenUnavailable");
  expect(result.monthlyBreakEvenCents).toBeNull();
  expect(result.dailyBreakEvenCents).toBeNull();
  expect(result.explain).toEqual([]);
 });
 it("does not invent zero when owner extras are absent and canonical facts unavailable",async()=>{
  const result=await moneyTools.get_break_even.execute(inputs,ctx(null));
  expect(result.missing).toContain("canonicalBreakEvenUnavailable");
  expect(result.periodBreakEvenCents).toBeNull();
 });
});

describe("get_payroll_facts known-only wages",()=>{
  it("keeps non-null missing-day wages UNKNOWN in AI, then accepts complete wages",async()=>{
    const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
    const laborDay={date:"2026-06-15",wagesCents:1250,staffTaxCents:150,
      loadedStaffCostCents:null,wageStatus:"missing" as const};
    const makeContext=(wageStatus:"missing"|"actual")=>({
      asOf:"2026-06-15",timezone:"America/Los_Angeles",locale:"en",
      tools:{
        getPayrollFacts:async()=>({available:false,value:null,quality:{
          ...quality,level:"low" as const,missingInputs:["toastPayrollRunsNotAvailable"]}}),
        getLaborMetrics:async()=>({available:true,value:[{...laborDay,wageStatus}],quality}),
      },
    }) as unknown as AgentToolContext;
    const missing=await executeAgentTool("get_payroll_facts",
      {from:"2026-06-15",to:"2026-06-15"},makeContext("missing"));
    expect(missing.observedLaborWagesCents).toBeNull();
    expect(missing.observedWageStatus).toBe("unknown");
    expect(missing.missing).toContain("laborWageUnknown:2026-06-15");
    const known=await executeAgentTool("get_payroll_facts",
      {from:"2026-06-15",to:"2026-06-15"},makeContext("actual"));
    expect(known.observedLaborWagesCents).toBe(1250);
    expect(known.observedWageStatus).toBe("recorded");
  });
});
