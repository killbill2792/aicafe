import {describe,it,expect} from "vitest";
import {moneyTools} from "./money";
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
 it("adds owner-stated monthly non-POS costs once, as a labeled estimate",async()=>{
  const result=await moneyTools.get_break_even.execute(inputs,ctx(3000));
  expect(result.ownerMonthlyPayrollExtrasCents).toBe(3000);
  expect(result.ownerDailyPayrollExtrasCents).toBe(100);
  expect(result.ownerMonthlyPayrollSource).toBe("You told me");
  expect(result.ownerMonthlyPayrollStatus).toBe("Estimate");
  expect(result.estimated).toContain("ownerMonthlyPayrollExtras");
  expect(result.ownerComparison).toMatchObject({
   dailyFixedCostsCents:10100,dailyBreakEvenSalesCents:12625
  });
 });
 it("never converts an unsaved monthly amount into zero or claims coverage",async()=>{
  const result=await moneyTools.get_break_even.execute(inputs,ctx(null));
  expect(result.ownerMonthlyPayrollExtrasCents).toBeNull();
  expect(result.ownerDailyPayrollExtrasCents).toBeNull();
  expect(result.missing).toContain(
   "ownerMonthlyPayrollExtrasNotSet:estimateExcludesUnknownAdditionalPayroll");
 });
});
