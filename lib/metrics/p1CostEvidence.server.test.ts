import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { executeP1Authorized } from "./p1Readers.server";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";

const period={from:"2026-10-01",to:"2026-10-03"};
const ctx={asOf:"2026-10-03",timezone:"America/Los_Angeles"};
const query=(p=period)=>({id:"money.business_costs",version:1,
  purpose:"actual_period_cost_review",period:p});
const costs=(overrides:Record<string,unknown>={})=>({
  period,knownTotalCents:0,completeness:"unavailable",
  components:{ingredientsCents:0,loadedStaffCents:0,cardFeesCents:0,runningCostsCents:0},
  observed:{ingredients:false,loadedStaff:false,cardFees:false,runningCosts:false},
  missingInputs:["salesCoverage:0/3"],estimatedInputs:[],
  coverage:{salesDays:0,laborDays:0,expectedDays:3,missingProductCostCount:0,
    itemSalesCovered:false,soldProductCount:null,estimatedProductCostCount:0,
    historicalIngredientCostsProven:false,soldProductIds:[],missingProductCostIds:[],
    estimatedProductCostIds:[],missingFeeDays:0,missingOperatingCategories:[]},
  ...overrides,
});
const call=(reader:ReturnType<typeof vi.fn>,p=period)=>
  executeP1Authorized({getBusinessCostSummary:reader} as unknown as BusinessScopedCafeTools,ctx,query(p));

describe("P1 canonical business-cost evidence regression",()=>{
  it("rejects a valid but wholly unobserved cost summary instead of publishing false zero",async()=>{
    const reader=vi.fn(async()=>costs());
    expect(await call(reader)).toEqual({status:"unavailable",value:null,reason:"unavailable_source"});
    expect(reader).toHaveBeenCalledWith(period);
  });
  it("preserves evidence-backed actual zero as a partial observed value",async()=>{
    const value=costs({completeness:"partial",
      observed:{ingredients:true,loadedStaff:false,cardFees:false,runningCosts:false}});
    const result=await call(vi.fn(async()=>value));
    expect(result).toMatchObject({status:"partial",actuality:"actual",
      value:{knownTotalCents:0,completeness:"partial"}});
  });
  it("accepts partially observed nonzero subtotal, rejects contradictory complete/missing and incorrect period",async()=>{
    const partial=costs({knownTotalCents:1200,completeness:"partial",
      observed:{ingredients:false,loadedStaff:true,cardFees:false,runningCosts:false}});
    expect(await call(vi.fn(async()=>partial))).toMatchObject({
      status:"partial",value:{knownTotalCents:1200}});
    expect(await call(vi.fn(async()=>costs({...partial,completeness:"complete"}))))
      .toMatchObject({status:"unavailable",reason:"invalid_result"});
    expect(await call(vi.fn(async()=>costs({...partial,period:{from:"2026-09-01",to:"2026-09-03"}}))))
      .toMatchObject({status:"unavailable",reason:"invalid_result"});
  });
  it("permits precisely the canonical seven-day cross-month Money week",async()=>{
    const week={from:"2026-09-27",to:"2026-10-03"};
    const summary=costs({period:week,knownTotalCents:600,
      completeness:"partial",observed:{ingredients:true,loadedStaff:false,cardFees:false,runningCosts:false},
      missingInputs:["priorMonthRunningCostCoverage"]});
    const reader=vi.fn(async()=>summary);
    expect(await call(reader,week)).toMatchObject({status:"partial",value:{knownTotalCents:600}});
    expect(reader).toHaveBeenCalledTimes(1);
    for(const wrong of [
      {from:"2026-09-26",to:"2026-10-03"},
      {from:"2026-09-27",to:"2026-10-02"},
      {from:"2026-08-27",to:"2026-10-03"},
      {from:"2026-10-04",to:"2026-10-04"},
    ]){
      const result=await call(reader,wrong);
      expect(result).toEqual({status:"unavailable",value:null,reason:"unsupported_period"});
    }
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it("never leaks expense categories without actual-vs-estimated source provenance",async()=>{
    const caller=vi.fn();
    const r=await executeP1Authorized({
      getExpenseSummary:caller,
    } as unknown as BusinessScopedCafeTools,ctx,{
      id:"money.expense_categories",version:1,purpose:"actual_period_expense_review",period,
    });
    expect(r).toEqual({status:"unavailable",value:null,reason:"unsupported"});
    expect(caller).not.toHaveBeenCalled();
  });
});
