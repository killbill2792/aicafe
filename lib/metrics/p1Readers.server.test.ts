import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { executeP1Authorized, registeredHandlerIds } from "./p1Readers.server";
import { values, readers } from "./p1Catalog";

const ctx={asOf:"2026-10-14",timezone:"America/Los_Angeles"};
const high={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const read=(t:Record<string, unknown>,query:unknown)=>
  executeP1Authorized(t as unknown as BusinessScopedCafeTools,ctx,query);
const bills={id:"money.monthly_bills",version:1,purpose:"recurring_obligation_review"};
const profit={id:"money.profitability",version:1,purpose:"actual_period_financial_review",
  period:{from:"2026-10-01",to:"2026-10-14"}};

describe("P1 typed authorized dispatch",()=>{
  it("binds every catalog entry to an implemented handler, with no orphans",()=>{
    expect([...registeredHandlerIds].sort()).toEqual(Object.keys(values).sort());
    expect(Object.keys(readers).sort()).toEqual([...registeredHandlerIds].sort());
  });
  it("reads known zero without converting missing bills to zero",async()=>{
    const tools={getMonthlyBills:vi.fn(async()=>({available:true as const,
      value:{totalCents:0},quality:high}))};
    const ok=await read(tools,bills);
    expect(ok).toMatchObject({status:"partial",value:{totalCents:0}});
    expect(tools.getMonthlyBills).toHaveBeenCalledTimes(1);
    const missing=await read({getMonthlyBills:vi.fn(async()=>({
      available:false as const,value:null,
      quality:{...high,level:"low" as const,missingInputs:["recurringBillsNotConfigured"]},
    }))},bills);
    expect(missing).toEqual({status:"unavailable",value:null,reason:"unavailable_source"});
  });
  it("refuses invalid requests before the reader, including cross-tenant selectors",async()=>{
    const fn=vi.fn();
    for(const arg of [
      {...bills,businessId:"someone-elses-cafe"},
      {...bills,sql:"select * from memberships"},
      {...bills,version:2},
      {...bills,purpose:"finance_forecast"},
      {...profit,period:{from:"2026-09-01",to:"2026-10-14"}},
      {...profit,period:{from:"2026-10-14",to:"2026-10-15"}},
    ]) {
      const r=await read({getMonthlyBills:fn,getProfitability:fn},arg);
      expect(r).toMatchObject({status:"unavailable",value:null});
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it("enforces the entire strict result contract on hostile reader payloads",async()=>{
    for(const amount of [1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+100,"100",true]){
      const r=await read({getMonthlyBills:vi.fn(async()=>({
        available:true as const,value:{totalCents:amount},quality:high,
      }))},bills);
      expect(r).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    }
    const r=await read({getMonthlyBills:vi.fn(async()=>({
      available:true as const,value:{totalCents:5500,secret:"do-not-expose"},quality:high,
    }))},bills);
    expect(r).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("preserves complete vs estimated vs observed-partial status",async()=>{
    const estimated=await read({getMonthlyBills:vi.fn(async()=>({
      available:true as const,value:{totalCents:100},quality:{
        ...high,level:"medium" as const,estimatedInputs:["recurringBills"],
      },
    }))},bills);
    expect(estimated).toMatchObject({status:"partial",value:{totalCents:100},
      actuality:"planned",completeness:"partial",quality:{estimatedInputs:["recurringBills"]}});
    const partial=await read({getProfitability:vi.fn(async()=>({
      available:true as const,
      value:{netSalesCents:10000,totalCostsCents:9000,ownerProfitCents:1000,
        operatingMargin:0.1,coveredSalesDays:5,expectedSalesDays:14},
      quality:{...high,level:"low" as const,missingInputs:["salesCoverage:5/14"]},
    }))},profit);
    expect(partial).toMatchObject({status:"partial",value:{ownerProfitCents:1000},
      completeness:"partial"});
  });
  it("does not treat planned schedule or unrecorded timecards as actual labor",async()=>{
    const attendance={id:"labor.attendance",version:1,purpose:"recorded_attendance",
      period:{from:"2026-10-01",to:"2026-10-14"}};
    const missing=await read({getStaffAttendance:vi.fn(async()=>({
      available:false as const,value:null,quality:{...high,level:"low" as const,missingInputs:["noRecordedTimecards"]},
    }))},attendance);
    expect(missing).toMatchObject({status:"unavailable",value:null});
    const schedule={id:"labor.recurring_assignments",version:1,purpose:"future_owner_assignment_review",
      period:{from:"2026-10-15",to:"2026-10-20"}};
    const scheduled=await read({getRecurringSchedule:vi.fn(async()=>({
      available:true as const,value:{source:"owner_recurring_schedule",from:"2026-10-15",to:"2026-10-20",shifts:[]},
      quality:high,
    }))},schedule);
    expect(scheduled).toMatchObject({status:"partial",actuality:"planned"});
  });
  it("never passes malformed money or private source errors as facts",async()=>{
    const q={id:"money.monthly_bills",version:1,purpose:"recurring_obligation_review"};
    const malformed=await read({getMonthlyBills:vi.fn(async()=>({
      available:true as const,value:{totalCents:"12"},quality:high,
    }))},q);
    expect(malformed).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    const exception=await read({getMonthlyBills:vi.fn(async()=>{throw Error("token=private");})},q);
    expect(exception).toEqual({status:"unavailable",value:null,reason:"reader_failure"});
    expect(JSON.stringify(exception)).not.toContain("token");
  });
  it("does not load unbounded signal data for a restricted P1 capability",async()=>{
    const reader=vi.fn();
    const result=await read({getActiveSignals:reader},{
      id:"team.signals",version:1,purpose:"observed_team_signal_status",
    });
    expect(result).toEqual({status:"unavailable",value:null,reason:"unsupported"});
    expect(reader).not.toHaveBeenCalled();
  });

});
