import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { resolveItemSalesCoverage, supervisorFactReaders } from "./supervisorFacts.server";

type Result = { data: unknown; error: null; count?:number|null };
function query(result: Result) {
  let range: {start:number;end:number}|null=null;
  const q = {
    select: () => q, eq: () => q, is: () => q,
    gte: () => q, lte: () => q, not: () => q, order: () => q,
    range: (start:number,end:number) => {range={start,end};return q;},
    then: (resolve: (value: Result) => void) => {
      const data=Array.isArray(result.data)&&range?
        result.data.slice(range.start,range.end+1):result.data;
      return Promise.resolve({...result,data}).then(resolve);
    },
  };
  return q;
}

describe("Supervisor owner-scoped facts", () => {
  it("reconciles monthly recurring bills with the exact Bills screen helper", async () => {
    const rows = [
      { id:"rent", amount_cents: 700_000, frequency: "monthly", is_estimate: false },
      { id:"insurance", amount_cents: 120_000, frequency: "yearly", is_estimate: true },
    ];
    const client = { from: vi.fn(() => query({ data: rows, error: null })) } as unknown as SupabaseClient;
    const reader = supervisorFactReaders(client, "cafe-a");
    const result = await reader.monthlyBills("cafe-a");
    expect(result).toMatchObject({
      available: true, value: { totalCents: 710_000 },
      quality: { estimatedInputs: ["recurringBills"] },
    });
    expect(client.from).toHaveBeenCalledWith("recurring_costs");
  });

  it("counts only recorded actual entries, not estimated or recurring schedules", async () => {
    const client = { from: vi.fn(() => query({ data: [
      { id:"a", amount_cents: 20_000, status: "actual" },
      { id:"e", amount_cents: 10_000, status: "estimated" },
    ], error: null })) } as unknown as SupabaseClient;
    const result = await supervisorFactReaders(client, "cafe-a").recordedExpenses("cafe-a", {
      from: "2026-10-01", to: "2026-10-10",
    });
    expect(result).toMatchObject({ available: true, value: { totalCents: 20_000 } });
    expect(client.from).toHaveBeenCalledWith("expenses");
  });

  it("does not certify silently capped expense results or partial count reads",async()=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const thousand=Array.from({length:1000},(_,i)=>({id:"id"+i,amount_cents:100,status:"actual"}));
    const truncated={from:vi.fn(()=>query({data:thousand,error:null,count:1001}))} as unknown as SupabaseClient;
    expect(await supervisorFactReaders(truncated,"cafe-a").recordedExpenses("cafe-a",period))
      .toMatchObject({available:false,quality:{missingInputs:["recordedExpensesCoverageUnverified"]}});
    const countMismatch={from:vi.fn(()=>query({data:thousand.slice(0,2),error:null,count:3}))} as unknown as SupabaseClient;
    expect(await supervisorFactReaders(countMismatch,"cafe-a").recordedExpenses("cafe-a",period))
      .toMatchObject({available:false,quality:{missingInputs:["recordedExpensesCoverageUnverified"]}});
  });

  it("pages every recorded actual receipt and bill across the transport row cap",async()=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const expenses=Array.from({length:1001},(_,i)=>({id:String(i).padStart(8,"0"),amount_cents:100,status:"actual"}));
    const bills=Array.from({length:1001},(_,i)=>({id:String(i).padStart(8,"0"),amount_cents:100,frequency:"monthly",is_estimate:false}));
    const client={from:vi.fn((table:string)=>query({data:table==="expenses"?expenses:bills,
      error:null,count:1001}))} as unknown as SupabaseClient;
    const readers=supervisorFactReaders(client,"cafe-a");
    expect(await readers.recordedExpenses("cafe-a",period)).toMatchObject({
      available:true,value:{totalCents:100100}});
    expect(await readers.monthlyBills("cafe-a")).toMatchObject({
      available:true,value:{totalCents:100100}});
  });

  it("does not turn out-of-range actual money into verified expense or bill totals",async()=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const expenses={from:vi.fn(()=>query({data:[
      {id:"overflow",amount_cents:"9007199254740993",status:"actual"}],error:null,count:1}))} as unknown as SupabaseClient;
    expect(await supervisorFactReaders(expenses,"cafe-a").recordedExpenses("cafe-a",period))
      .toMatchObject({available:false,quality:{missingInputs:["recordedExpensesAmountsUnverified"]}});
    const bills={from:vi.fn(()=>query({data:[
      {id:"unrecognized",amount_cents:100,frequency:"unrecognized",is_estimate:false}],error:null,count:1}))} as unknown as SupabaseClient;
    expect(await supervisorFactReaders(bills,"cafe-a").monthlyBills("cafe-a"))
      .toMatchObject({available:false,quality:{missingInputs:["recurringBillsAmountsUnverified"]}});
  });

  it("does not promote item quantities to complete totals without verified backfill", async () => {
    const client = { from: vi.fn(() => query({ data: [], error: null })), rpc: vi.fn() } as unknown as SupabaseClient;
    const result = await supervisorFactReaders(client, "cafe-a").productSales("cafe-a", {
      from: "2026-10-01", to: "2026-10-10",
    });
    expect(result).toMatchObject({ available: false, quality: { missingInputs: ["itemSalesCoverage"] } });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("obtains date-scoped quantities through the invoker-RLS RPC with all menu items", async () => {
    const client = {
      from: vi.fn((table: string) => query({ data: table === "pos_connections"
        ? [{ provider:"square",last_synced_at: "2026-10-10T23:00:00Z", backfill_completed_at: "2026-10-01T20:00:00Z" }]
        : [{ id: "one", name: "Latte", category: "drink" }, { id: "two", name: "Muffin", category: "food" }],
      error: null })),
      rpc: vi.fn(() => query({ data: [{ menu_item_id: "one", total_quantity: 19 }], error: null })),
    } as unknown as SupabaseClient;
    const result = await supervisorFactReaders(client, "cafe-a").productSales("cafe-a", {
      from: "2026-10-01", to: "2026-10-10",
    });
    expect(result).toMatchObject({ available: true, value: [
      { id: "one", units: 19 }, { id: "two", units: 0 },
    ] });
    expect(client.rpc).toHaveBeenCalledWith("menu_item_quantities_sold", {
      p_business_id: "cafe-a", p_from: "2026-10-01", p_to: "2026-10-10",
    },{count:"exact"});
  });

  it("pages all 1001 distinct source menu items and RPC quantities without dropping the last",async()=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const rows=Array.from({length:1001},(_,i)=>({
      id:"menu:"+String(i).padStart(5,"0"),name:"Item "+i,category:"food"}));
    const quantities=rows.map((item,i)=>({menu_item_id:item.id,total_quantity:i===999?1.5:i===1000?"2.25":2}));
    const client={
      from:vi.fn((table:string)=>query({data:table==="pos_connections"
        ?[{provider:"square",last_synced_at:"2026-10-10T23:00:00Z",
           backfill_completed_at:"2026-10-01T20:00:00Z"}]:rows,error:null,
           count:table==="pos_connections"?1:1001})),
      rpc:vi.fn(()=>query({data:quantities,error:null,count:1001}))
    } as unknown as SupabaseClient;
    const result=await supervisorFactReaders(client,"cafe-a").productSales("cafe-a",period);
    expect(result.available).toBe(true);
    if(!result.available)return;
    expect(result.value).toHaveLength(1001);
    expect(result.value[999]).toMatchObject({id:"menu:00999",units:1.5});
    expect(result.value[1000]).toMatchObject({id:"menu:01000",units:2.25});
  });

  it.each([-1, Infinity, NaN, Number.MAX_SAFE_INTEGER+1, ""])("does not certify invalid sold quantities %s",async(total_quantity)=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const client={from:vi.fn((table:string)=>query({data:table==="pos_connections"
      ?[{provider:"square",last_synced_at:"2026-10-10T23:00:00Z",backfill_completed_at:"2026-10-01T20:00:00Z"}]
      :[{id:"known",name:"Latte",category:"drink"}],error:null})),
      rpc:vi.fn(()=>query({data:[{menu_item_id:"known",total_quantity}],error:null}))} as unknown as SupabaseClient;
    expect(await supervisorFactReaders(client,"cafe-a").productSales("cafe-a",period))
      .toMatchObject({available:false,quality:{missingInputs:["productSalesMappingUnverified"]}});
  });

  it("does not certify product sales with orphan, duplicated or unsafe quantities",async()=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const client={
      from:vi.fn((table:string)=>query({data:table==="pos_connections"
        ?[{provider:"square",last_synced_at:"2026-10-10T23:00:00Z",
           backfill_completed_at:"2026-10-01T20:00:00Z"}]
        :[{id:"known",name:"Latte",category:"drink"}],error:null})),
      rpc:vi.fn(()=>query({data:[{menu_item_id:"orphan",total_quantity:5}],error:null})),
    } as unknown as SupabaseClient;
    const result=await supervisorFactReaders(client,"cafe-a").productSales("cafe-a",period);
    expect(result).toMatchObject({available:false,quality:{missingInputs:["productSalesMappingUnverified"]}});
  });

  it("only proves explicitly contracted Square item-sales backfill; unknown provider remains unproven",()=>{
    const period={from:"2026-10-01",to:"2026-10-10"};
    const base={last_synced_at:"2026-10-10T23:00:00Z",backfill_completed_at:"2026-10-01T20:00:00Z"};
    expect(resolveItemSalesCoverage([{provider:"toast",...base}],period).covered).toBe(false);
    expect(resolveItemSalesCoverage([{provider:"square",...base}],period))
      .toMatchObject({covered:true,sources:["square_backfill"],from:"2026-10-01",through:"2026-10-10"});
    expect(resolveItemSalesCoverage([{provider:"square",...base,last_synced_at:"2026-10-09T20:00:00Z"}],period).covered).toBe(false);
  });
  it("denies cross-café and empty identifiers before hitting any database reader", async () => {
    const client = { from: vi.fn(), rpc: vi.fn() } as unknown as SupabaseClient;
    const readers = supervisorFactReaders(client, "cafe-a");
    await expect(readers.monthlyBills("cafe-b")).rejects.toThrow("scope mismatch");
    await expect(readers.recordedExpenses("", { from: "2026-10-01", to: "2026-10-10" }))
      .rejects.toThrow("scope mismatch");
    await expect(readers.productSales("cafe-b", { from: "2026-10-01", to: "2026-10-10" }))
      .rejects.toThrow("scope mismatch");
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
