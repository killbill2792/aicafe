import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {executeP1Authorized} from "./p1Readers.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import {metricUnits, purposePolicies} from "./p1Catalog";

const ctx={asOf:"2026-10-14",timezone:"America/Los_Angeles"};
const period={from:"2026-10-01",to:"2026-10-14"};
const high={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const read=(tool:Record<string,unknown>,id:keyof typeof metricUnits)=>
  executeP1Authorized(tool as unknown as BusinessScopedCafeTools,ctx,{
    id,version:1,purpose:purposePolicies[id][0],granularity:"period",
    ...(!id.includes("monthly_bills")?{period}:{}),
  });
const values={netSalesCents:12000,totalCostsCents:8000,ownerProfitCents:4000,
  operatingMargin:1/3,coveredSalesDays:14,expectedSalesDays:14};
const profitReader=(v:unknown=values)=>({getProfitability:vi.fn(async()=>({
  available:true as const,value:v,quality:high,
}))});

describe("P1 unit-specific canonical scalar metrics",()=>{
  it("projects cent and ratio values directly from existing period profitability",async()=>{
    for(const [id,expected] of [
      ["money.owner_profit_cents",4000],["sales.net_sales_cents",12000],
      ["money.total_costs_cents",8000],["money.operating_margin_ratio",1/3],
    ] as const){
      const tools=profitReader();
      const result=await read(tools,id);
      expect(result).toMatchObject({status:"partial",id,value:expected,actuality:"actual"});
      expect(tools.getProfitability).toHaveBeenCalledWith(period);
      expect(metricUnits[id]).toBe(id==="money.operating_margin_ratio"?"ratio":"USD_cents");
    }
  });
  it("rejects mixed-unit or malformed canonical profitability before exposing a valid-looking scalar",async()=>{
    for(const source of [
      {...values,netSalesCents:100.5},
      {...values,operatingMargin:Infinity},
      {...values,privateWageId:"employee-other-cafe"},
      {...values,coveredSalesDays:15},
    ]){
      const result=await read(profitReader(source),"money.owner_profit_cents");
      expect(result).toEqual({status:"unavailable",value:null,reason:"invalid_result"});
    }
  });
  it("never interprets unavailable profitability or bills as a verified zero",async()=>{
    const missing={available:false as const,value:null,quality:{
      ...high,level:"low" as const,missingInputs:["wages_unknown"],
    }};
    expect(await read({getProfitability:vi.fn(async()=>missing)},"money.owner_profit_cents"))
      .toEqual({status:"unavailable",value:null,reason:"unavailable_source"});
    const billMetric="money.recurring_monthly_bills_cents";
    const zero=await read({getMonthlyBills:vi.fn(async()=>({
      available:true as const,value:{totalCents:0},quality:high,
    }))},billMetric);
    expect(zero).toMatchObject({status:"partial",value:0});
    expect(await read({getMonthlyBills:vi.fn(async()=>missing)},billMetric))
      .toEqual({status:"unavailable",value:null,reason:"unavailable_source"});
  });
  it("rejects unsupported granularity and future periods before querying a source",async()=>{
    const reader=vi.fn();
    for(const args of [
      {id:"sales.net_sales_cents",version:1,purpose:"actual_period_net_sales",period,granularity:"hour"},
      {id:"sales.net_sales_cents",version:1,purpose:"actual_period_net_sales",period:{from:"2026-10-14",to:"2026-10-15"},granularity:"period"},
      {id:"sales.net_sales_cents",version:1,purpose:"actual_period_net_sales",period:{from:"2026-09-01",to:"2026-09-30"},granularity:"period"},
    ]){
      const result=await executeP1Authorized({getProfitability:reader} as unknown as BusinessScopedCafeTools,ctx,args);
      expect(result).toMatchObject({status:"unavailable"});
    }
    expect(reader).not.toHaveBeenCalled();
  });
});
