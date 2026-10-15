import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {executeP1Authorized,outputFor} from "./p1Readers.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
const scope={asOf:"2026-10-14",timezone:"America/Los_Angeles"};
const request={id:"money.recurring_monthly_bills_cents",version:1,
  purpose:"recurring_monthly_obligation_metric",granularity:"period"};
const reader={getMonthlyBills:vi.fn(async()=>({
  available:true as const,value:{totalCents:0},
  quality:{level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]},
}))} as unknown as BusinessScopedCafeTools;
describe("P1 full typed value/output contract",()=>{
  it("publishes exact units and query without fabricating source revision or freshness",async()=>{
    const r=await executeP1Authorized(reader,scope,request);
    expect(r).toMatchObject({
      status:"partial",id:"money.recurring_monthly_bills_cents",
      query:request,unit:"USD_cents",valueKind:"money_cents",
      freshness:{asOf:"2026-10-14",capturedAt:null,stale:null},
      provenance:{sourceRevision:null,timezone:"America/Los_Angeles"},value:0,
    });
    expect(outputFor("money.recurring_monthly_bills_cents").safeParse(r).success).toBe(true);
  });
  it("rejects incorrect units, forged verified state, mismatched contract key and input",async()=>{
    const r=await executeP1Authorized(reader,scope,request) as Record<string,unknown>;
    const s=outputFor("money.recurring_monthly_bills_cents");
    expect(s.safeParse({...r,unit:"USD"}).success).toBe(false);
    expect(s.safeParse({...r,valueKind:"duration_minutes"}).success).toBe(false);
    expect(s.safeParse({...r,id:"money.recorded_spending_cents"}).success).toBe(false);
    expect(s.safeParse({...r,status:"verified",completeness:"complete"}).success).toBe(false);
    expect(s.safeParse({...r,query:{...request,granularity:"hour"}}).success).toBe(false);
    expect(s.safeParse({...r,secretSourceId:"private"}).success).toBe(false);
  });
});
