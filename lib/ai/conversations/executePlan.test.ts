import { describe, expect, it, vi } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { cafeStateFromSnapshot } from "@/lib/operating/cafeState";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { SupervisorPlan } from "./planner.server";
import { executeSupervisorPlan } from "./executePlan";

const fixture = getFixtureSnapshot();
const state = cafeStateFromSnapshot(fixture);
const quality = { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] };
const copy = {
  unsupported: "Unsupported", missingEvidence: "Verified data is missing",
  estimatedNotice: "Some figures are estimated", todayOverview: "Today's performance",
  monthOverview: "Monthly performance", weekOverview: "Last seven days",
  periodUnavailable: "Period unavailable", sales: "Net sales", totalCosts: "Total costs",
  ownerProfit: "Owner profit", recurringBills: "Monthly bills", billsIntro: "Bills",
  monthlyBillsIntro: "Full monthly budget", accruedBillsIntro: "Calendar accrual",
  actualExpensesIntro: "Recorded expense entries", businessCostsIntro: "Modeled business costs",
  actualExpensesLabel: "Recorded expenses", accruedBillsLabel: "Accrued bills",
  periodRange: (from: string, to: string) => from + " to " + to,
  salesQuantityIntro: "Covered sales", unitsSold: "Units sold", ordersCount: "Orders",
  drinksCount: "Drinks", distinctProducts: "Distinct products",
  menuTotal: "Products in menu", menuActive: "Active products",
  menuCategoryDrink: "Drinks in menu", menuCategoryFood: "Food in menu",
  menuStockNotice: "Live stock availability is not tracked yet.",
  menuListIntro: "Active menu:",
  menuProductDetails: (name: string, category: string) => name + " / " + category,
  noSalesToday: "No sales have been recorded for today yet.",
  bestSeller: (name: string) => "Best: " + name,
  leastSeller: (name: string) => "Least: " + name,
  matchedProduct: (name: string) => name + " units",
  productNotFound: "Can't verify coffee taxonomy",
  productUnitsUnavailable: "Item-level totals missing; showing aggregates",
  pricingIntro: "Pricing", pricingNone: "No pricing review",
  pricingUnavailable: "No pricing", pricingCaution: "Review only",
  priceLabel: (name: string) => "Price: " + name,
  tasks: (needs: number, handled: number, watching: number) => [needs, handled, watching].join("/"),
  staffingTasks: (count: number) => String(count), staffingNone: "None",
  rulesIntro: "Active rules", rulesNone: "No rules",
  ruleItem: (agent: string, instruction: string) => agent + ": " + instruction,
  taskCard: (kind: string, name: string) => kind + ": " + name,
  taskGroup: (status: string, count: number) => status + " " + count,
  clarifyPeriod: "Which period?", clarifyProduct: "Which product?",
  clarifyQuestion: "What question?",
};
function tools(overrides: Record<string, unknown> = {}) {
  return {
    getMonthlyBills: vi.fn(async () => ({ available: true, value: { totalCents: 730_000 }, quality })),
    getRecordedExpenses: vi.fn(async () => ({ available: true, value: { totalCents: 70_000 }, quality })),
    getProfitability: vi.fn(async (period: { from: string; to: string }) =>
      cafeStateFromSnapshot(fixture, period).profitability),
    getSalesTrend: vi.fn(async (period: { from: string; to: string }) =>
      cafeStateFromSnapshot(fixture, period).sales),
    getProductSales: vi.fn(async () => ({ available: true, value: [
      { id: "a", name: "Latte", category: "drink", units: 60 },
      { id: "b", name: "Mocha", category: "drink", units: 12 },
      { id: "c", name: "Muffin", category: "food", units: 24 },
    ], quality })),
    getTeamTasks: vi.fn(async () => ({ available: true, value: [], quality })),
    ...overrides,
  } as unknown as BusinessScopedCafeTools;
}
async function ask(plan: SupervisorPlan, scoped = tools()) {
  return executeSupervisorPlan({
    plan, state, tools: scoped, copy, readRules: async () => [],
  });
}

describe("Responses executor preserves canonical accounting and evidence", () => {
  it("answers 'how many products are in my menu' from CafeState, never Square product-sales backfill", async () => {
    const scoped = tools({ getProductSales: vi.fn(async () => { throw new Error("must not query POS"); }) });
    const answer = await ask({ name: "read_menu", arguments: {
      operation: "product_count", product_name: null,
    } }, scoped);
    expect(answer.intent).toBe("menu_catalog");
    expect(answer.blocks.find((b) => b.type === "count")).toMatchObject({
      label: "Products in menu", value: fixture.menuItems.length,
    });
    expect(scoped.getProductSales).not.toHaveBeenCalled();
  });
  it("answers 'what are my total products that are available for today' without fake inventory", async () => {
    const scoped = tools();
    const answer = await ask({ name: "read_menu", arguments: {
      operation: "active_product_count", product_name: null,
    } }, scoped);
    expect(answer.blocks.find((b) => b.type === "count")).toMatchObject({
      label: "Active products", value: fixture.menuItems.filter((p) => p.active !== false).length,
    });
    expect(answer.blocks.some((b) => b.type === "text" && b.text.includes("Live stock"))).toBe(true);
    expect(scoped.getProductSales).not.toHaveBeenCalled();
  });
  it("answers 'what are my total sales for today' without reporting a fabricated zero", async () => {
    const noToday = { ...state, sales: { available: true as const, value: state.sales.available
      ? state.sales.value.filter((day) => day.date !== state.asOf) : [], quality } };
    const scoped = tools({ getSalesTrend: vi.fn(async () => {
      throw new Error("no today rollup to sum");
    }) });
    const answer = await executeSupervisorPlan({
      plan: { name: "read_sales", arguments: { metric: "sales_revenue", period: "today",
        category: "all", product_name: null } }, state: noToday, tools: scoped,
      copy, readRules: async () => [],
    });
    expect(answer.blocks).toMatchObject([{ type: "text", text: "No sales have been recorded for today yet." }]);
    expect(answer.blocks.some((b) => b.type === "metric")).toBe(false);
    expect(scoped.getSalesTrend).not.toHaveBeenCalled();
  });
  it("answers previously failed month expense question with canonical total costs, not bills", async () => {
    const scoped = tools();
    const reply = await ask({ name: "read_finances", arguments: {
      metric: "total_business_costs", period: "month_to_date",
    } }, scoped);
    expect(scoped.getProfitability).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-09" });
    expect(scoped.getMonthlyBills).not.toHaveBeenCalled();
    const canonical = cafeStateFromSnapshot(fixture).profitability;
    expect(reply.blocks.find((b) => b.type === "metric")).toMatchObject({
      label: "Total costs", valueCents: canonical.available ? canonical.value.totalCostsCents : -1,
    });
    expect(reply.blocks.some((b) => b.type === "text" && b.text.includes("2026-09-01 to 2026-09-09"))).toBe(true);
  });
  it("keeps monthly Bills' full budget apart from calendar accrual", async () => {
    const budget = await ask({ name: "read_finances", arguments: {
      metric: "monthly_bills", period: "month_to_date",
    } });
    const accrual = await ask({ name: "read_finances", arguments: {
      metric: "accrued_fixed_bills", period: "month_to_date",
    } });
    expect(budget.blocks.find((b) => b.type === "metric")).toMatchObject({ valueCents: 730_000 });
    expect(accrual.blocks.find((b) => b.type === "metric")).toMatchObject({ valueCents: 219_000 });
  });
  it("does not prorate already-recorded expense entries", async () => {
    const actual = await ask({ name: "read_finances", arguments: {
      metric: "recorded_spending", period: "month_to_date",
    } });
    expect(actual.blocks.find((b) => b.type === "metric")).toMatchObject({ valueCents: 70_000 });
  });
  it("withholds costs rather than guessing when canonical product costs are missing", async () => {
    const reply = await ask({ name: "read_finances", arguments: {
      metric: "total_business_costs", period: "month_to_date",
    } }, tools({ getProfitability: async () => ({
      available: false, value: null, quality: { ...quality, level: "low", missingInputs: ["productCosts"] },
    }) }));
    expect(reply.status).toBe("insufficient_evidence");
    expect(reply.blocks.every((b) => b.type !== "metric")).toBe(true);
  });
  it("answers product units separately from 28-day snapshot, drinks and orders", async () => {
    const scoped = tools();
    const reply = await ask({ name: "read_sales", arguments: {
      metric: "product_units", period: "month_to_date", category: "all", product_name: null,
    } }, scoped);
    expect(scoped.getProductSales).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-09" });
    expect(reply.blocks.find((b) => b.type === "count")).toMatchObject({ value: 96 });
    expect(fixture.menuItems[0].quantitySoldLast28Days).toBe(3360);
    const drinks = await ask({ name: "read_sales", arguments: {
      metric: "drinks", period: "today", category: "all", product_name: null,
    } }, scoped);
    const orders = await ask({ name: "read_sales", arguments: {
      metric: "orders", period: "today", category: "all", product_name: null,
    } }, scoped);
    expect(drinks.blocks.find((b) => b.type === "count")).toMatchObject({ value: fixture.todayDay.drinksCount });
    expect(orders.blocks.find((b) => b.type === "count")).toMatchObject({ value: fixture.todayDay.ordersCount });
  });
  it("finds verified best and least sold products without inventing ranking", async () => {
    const best = await ask({ name: "read_sales", arguments: {
      metric: "best_seller", period: "month_to_date", category: "drink", product_name: null,
    } });
    const least = await ask({ name: "read_sales", arguments: {
      metric: "least_seller", period: "month_to_date", category: "all", product_name: null,
    } });
    expect(best.blocks.find((b) => b.type === "count")).toMatchObject({ label: "Best: Latte", value: 60 });
    expect(least.blocks.find((b) => b.type === "count")).toMatchObject({ label: "Least: Mocha", value: 12 });
  });
  it("only uses verified daily aggregate counts when product coverage is unavailable", async () => {
    const unavailable = await ask({ name: "read_sales", arguments: {
      metric: "product_units", period: "month_to_date", category: "all", product_name: null,
    } }, tools({ getProductSales: async () => ({
      available: false, value: null, quality: { ...quality, level: "low", missingInputs: ["productCoverage"] },
    }) }));
    expect(unavailable.blocks.filter((b) => b.type === "count").map((b) =>
      b.type === "count" ? b.label : "")).toEqual(["Drinks", "Orders"]);
    expect(unavailable.blocks.some((b) => b.type === "warning" && b.code === "item_units_unavailable")).toBe(true);
  });
  it("rejects coffee taxonomy guesses and unidentified named products", async () => {
    const result = await ask({ name: "read_sales", arguments: {
      metric: "product_units", period: "month_to_date", category: "coffee", product_name: null,
    } });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.evidence).toEqual([]);
  });
  it("produces real persisted task cards with read-only operations links and matching evidence", async () => {
    const task = {
      id: "task-123", businessId: "fixture-a", agentId: "maya", kind: "supply_check",
      status: "needs_response", payload: { itemName: "Oat milk" }, confidence: "high",
      evidence: [{ source: "recorded", facts: {} }], createdAt: "2026-09-09T00:00:00Z",
    };
    const answer = await ask({ name: "read_team", arguments: {
      agent: "all", status: "needs_you",
    } }, tools({ getTeamTasks: async () => ({ available: true, value: [task], quality }) }));
    expect(answer.blocks.find((b) => b.type === "task_card")).toMatchObject({
      agent: "maya", title: "supply_check: Oat milk", href: "/operations?status=needs_you&agent=maya",
    });
    const { validateGroundedReply } = await import("./replyValidation");
    expect(() => validateGroundedReply(answer)).not.toThrow();
  });
  it("never relabels previous-month or yesterday questions as current", async () => {
    const scoped = tools();
    for (const period of ["previous_month", "yesterday", "other_period"] as const) {
      const reply = await ask({ name: "read_finances", arguments: {
        metric: "monthly_bills", period,
      } }, scoped);
      expect(reply.status).toBe("insufficient_evidence");
      expect(reply.blocks).toMatchObject([{ type: "warning", code: "unsupported_period" }]);
    }
    expect(scoped.getMonthlyBills).not.toHaveBeenCalled();
  });
  it("answers a named coffee product but never invents a complete coffee category", async () => {
    const reply = await ask({ name: "read_sales", arguments: {
      metric: "named_product_units", period: "month_to_date",
      category: "coffee", product_name: "Latte",
    } });
    expect(reply.blocks.find((block) => block.type === "count")).toMatchObject({ value: 60 });
    const missing = await ask({ name: "read_sales", arguments: {
      metric: "named_product_units", period: "month_to_date",
      category: "drink", product_name: null,
    } });
    expect(missing.status).toBe("insufficient_evidence");
  });

  it("never fabricates team task claims when Team reader is unavailable", async () => {
    const answer = await ask({ name: "read_team", arguments: {
      agent: "all", status: "all",
    } }, tools({ getTeamTasks: async () => ({
      available: false, value: null, quality: { ...quality, level: "low", missingInputs: ["tasks"] },
    }) }));
    expect(answer.blocks.every((b) => b.type !== "task_card")).toBe(true);
  });
});
