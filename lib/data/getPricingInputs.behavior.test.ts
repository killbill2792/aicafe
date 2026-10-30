import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const deps = vi.hoisted(() => ({
  readDays: vi.fn(),
  readCombos: vi.fn(),
  feePlans: vi.fn(),
  timed: vi.fn(async (_page: string, _stage: string, read: () => Promise<unknown>) => read()),
}));
vi.mock("./dailyFacts.server", () => ({ readDailyFacts: deps.readDays }));
vi.mock("./comboCosts.server", () => ({ readMenuComboCostComponents: deps.readCombos }));
vi.mock("@/lib/pos/processingFeeEstimate.server", () => ({
  getOwnerConfirmedProcessingFeePlans: deps.feePlans,
}));
vi.mock("@/lib/perf/timeReader.server", () => ({ timeReader: deps.timed }));
import { getPricingInputs } from "./getPricingInputs";

function dbWithOrders(spy: string[], orderError = false) {
  const values: Record<string, unknown> = {
    businesses: { timezone: "America/Los_Angeles", currency: "EUR" },
    menu_items: [{ id: "latte", name: "Latte", category: "drink", price_cents: 350, prep_seconds: 60 }],
    orders: [{ business_date: "2026-10-30", pos_order_id: "real-1", net_sales_cents: 1000, processing_fee_provider: "toast" }],
    expenses: [], recurring_costs: [], recipe_lines: [], menu_item_cost_fallbacks: [],
  };
  const from = (table: string) => {
    if (table === "orders") spy.push("orders");
    const response = () => ({
      data: values[table] ?? [],
      error: table === "orders" && orderError ? { message: "order history unavailable" } : null,
    });
    const builder = {
      select: () => builder, eq: () => builder, gte: () => builder,
      lte: () => builder, lt: () => builder, is: () => builder,
      in: () => builder, order: () => builder,
      single: async () => response(),
      then: (resolve: (value: ReturnType<typeof response>) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return builder;
  };
  return {
    from, rpc: async () => ({ data: [{ menu_item_id: "latte", total_quantity: 10 }], error: null }),
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
    deps.readCombos.mockResolvedValue([]);
    deps.feePlans.mockResolvedValue([]);
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
    expect(fullCalls).toEqual(["orders"]);
  });

  it("does not skip failed order evidence when sales coverage could support business pricing", async () => {
    deps.readDays.mockResolvedValue(salesDays(45));
    const calls: string[] = [];
    await expect(getPricingInputs(dbWithOrders(calls, true), "cafe-a", { attentionOnly: true }))
      .rejects.toMatchObject({ message: "order history unavailable" });
    expect(calls).toEqual(["orders"]);
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
