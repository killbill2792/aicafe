import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const deps = vi.hoisted(() => ({
  readDays: vi.fn(),
  runningCosts: vi.fn(),
  readCosts: vi.fn(),
  feePlans: vi.fn(),
  timed: vi.fn(async (_page: string, _stage: string, read: () => Promise<unknown>) => read()),
}));
vi.mock("./runningCostLines.server", () => ({ readRunningCostLines: deps.runningCosts }));
vi.mock("./dailyFacts.server", () => ({ readDailyFacts: deps.readDays }));
vi.mock("./productCosts.server", () => ({ readProductCosts: deps.readCosts }));
vi.mock("@/lib/pos/processingFeeEstimate.server", () => ({
  getOwnerConfirmedProcessingFeePlans: deps.feePlans,
}));
vi.mock("@/lib/perf/timeReader.server", () => ({ timeReader: deps.timed }));
import { getPricingInputs } from "./getPricingInputs";

function dbWithOrders(spy: string[], orderError = false) {
  const values: Record<string, unknown> = {
    businesses: { timezone: "America/Los_Angeles", currency: "EUR" },
    menu_catalog_for: [{ id: "latte", name: "Latte", category: "drink", price_cents: 350, prep_seconds: 60 }],
    cv_orders:[{ business_date: "2026-10-30", pos_order_id: "real-1", net_sales_cents: 1000, processing_fee_provider: "toast" }],
    cv_expenses: [], cv_bills: [], recipe_lines: [], menu_item_cost_fallbacks: [],
  };
  const from = (table: string) => {
    if (table === "cv_orders") spy.push("cv_orders");
    const response = () => ({
      data: values[table] ?? [],
      error: table === "cv_orders" && orderError ? { message: "order history unavailable" } : null,
    });
    const builder = {
      select: () => builder,
      like: () => builder, eq: () => builder, gte: () => builder,
      lte: () => builder, lt: () => builder, is: () => builder,
      in: () => builder, order: () => builder,
      single: async () => response(),
      then: (resolve: (value: ReturnType<typeof response>) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return builder;
  };
  return {
    from, rpc: (name:string) => name==="menu_catalog_for"?from(name):
      Promise.resolve({ data: [{ menu_item_id: "latte", total_quantity: 10 }], error: null }),
  } as unknown as SupabaseClient;
}

function salesDays(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10),
    netSalesCents: 1000, drinksCount: 10, wagesCents: null, staffTaxCents: null,
    laborWageStatus: "missing", staffTaxStatus: "missing",
    salesDataStatus: "actual", cardFeesCents: null, cardFeesStatus: "missing",
  }));
}

describe("getPricingInputs Home projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.runningCosts.mockResolvedValue([]);
    deps.readCosts.mockResolvedValue(new Map([["latte",{costCents:123,status:"READY",source:"recipe",estimated:false,recipe:[]}]]));
    deps.feePlans.mockResolvedValue([]);
  });

  it("uses the canonical monthly operating-cost result without reading bills and receipts separately", async () => {
    deps.readDays.mockResolvedValue(salesDays(45));
    deps.runningCosts.mockResolvedValue([{categoryCode:"rent",amountCents:12345,isMissing:false,isEstimate:true,amountSource:"mixed"}]);
    const result=await getPricingInputs(dbWithOrders([]),"cafe-a");
    expect(result.business.monthlyOperatingCostCents).toBe(12345);
    expect(result.items[0]).toMatchObject({productCostCents:123,productCostStatus:"READY",productCostSource:"recipe"});
    expect(result.menuPriceBasis.runningStatus).toBe("estimated");
    expect(deps.runningCosts).toHaveBeenCalledOnce();
  });

  it("skips irrelevant order rows on Home but retains identical Menu/chat pricing fields", async () => {
    deps.readDays.mockResolvedValue(salesDays(44));
    const calls: string[] = [];
    const db = dbWithOrders(calls, true);
    const home = await getPricingInputs(db, "cafe-a", { attentionOnly: true });
    expect(calls).toEqual([]);
    expect(home.business.totalOrdersInWindow).toBe(0);
    const fullCalls: string[] = [];
    await expect(getPricingInputs(dbWithOrders(fullCalls, true), "cafe-a")).rejects.toMatchObject({ message: "order history unavailable" });
    expect(fullCalls).toEqual(["cv_orders"]);
  });

  it("does not skip failed order evidence when sales coverage could support business pricing", async () => {
    deps.readDays.mockResolvedValue(salesDays(45));
    const calls: string[] = [];
    await expect(getPricingInputs(dbWithOrders(calls, true), "cafe-a", { attentionOnly: true }))
      .rejects.toMatchObject({ message: "order history unavailable" });
    expect(calls).toEqual(["cv_orders"]);
  });

  it("preserves full reader results in both modes when trusted order evidence is needed", async () => {
    deps.readDays.mockResolvedValue(salesDays(45));
    const full = await getPricingInputs(dbWithOrders([]), "cafe-a");
    const home = await getPricingInputs(dbWithOrders([]), "cafe-a", { attentionOnly: true });
    expect(home).toEqual(full);
    expect(deps.timed).toHaveBeenCalledWith("Home", "pricing.dailyFacts", expect.any(Function));
    expect(deps.timed).toHaveBeenCalledWith("Home", "pricing.trustedOrders", expect.any(Function));
  });
});
