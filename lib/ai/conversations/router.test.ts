import { describe, expect, it, vi } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { cafeStateFromSnapshot } from "@/lib/operating/cafeState";
import { suggestPrice } from "@/lib/calc/pricingEngine";
import { getPricingProfile } from "@/lib/pricing/profiles";
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import type { SupervisorReplyCopy } from "./router";
import { answerSupervisorQuestion, detectSupervisorIntent } from "./router";

const fixture = getFixtureSnapshot();
const copy: SupervisorReplyCopy = {
  unsupported: "Unsupported, ask about cafe data",
  missingEvidence: "Not enough verified data",
  estimatedNotice: "Includes estimates",
  todayOverview: "Today from recorded data",
  monthOverview: "This month from recorded data",
  weekOverview: "Last seven calendar days",
  periodUnavailable: "Previous periods are unavailable",
  sales: "Sales",
  totalCosts: "Costs",
  ownerProfit: "Owner profit",
  recurringBills: "Bills",
  billsIntro: "These are recurring bills",
  monthlyBillsIntro: "Monthly budget:",
  accruedBillsIntro: "Accrued:",
  actualExpensesIntro: "Recorded:",
  businessCostsIntro: "Canonical costs:",
  actualExpensesLabel: "Actual expenses",
  accruedBillsLabel: "Accrued bills",
  periodRange: (from, to) => from + " to " + to,
  salesQuantityIntro: "Quantities:",
  unitsSold: "Units",
  ordersCount: "Orders",
  drinksCount: "Drinks",
  distinctProducts: "Distinct",
  bestSeller: (name) => "Most: " + name,
  leastSeller: (name) => "Least: " + name,
  matchedProduct: (name) => "Units: " + name,
  productNotFound: "No identified item",
  pricingIntro: "Review products",
  pricingNone: "No recorded pricing reviews",
  pricingUnavailable: "Pricing unavailable",
  pricingCaution: "Review only",
  priceLabel: (name) => "Review " + name,
  tasks: (n, h, w) => "Needs " + n + " handled " + h + " watching " + w,
  staffingTasks: (n) => "Olivia has " + n + " open tasks",
  staffingNone: "No open Olivia tasks recorded",
  rulesIntro: "Approved guidance only",
  rulesNone: "No approved rules",
  ruleItem: (agent, instruction) => agent + ": " + instruction,
};

function tools(overrides: Record<string, unknown> = {}): BusinessScopedCafeTools {
  return {
    getProfitability: vi.fn(async () =>
      cafeStateFromSnapshot(fixture, { from: "2026-09-09", to: "2026-09-09" }).profitability),
    getExpenseSummary: vi.fn(async () =>
      cafeStateFromSnapshot(fixture, { from: "2026-09-09", to: "2026-09-09" }).expenses),
    getTeamTasks: vi.fn(async () => ({
      available: true, value: [], quality: {
        level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [],
      },
    })),
    ...overrides,
  } as unknown as BusinessScopedCafeTools;
}

describe("Phase 4 finite Supervisor router", () => {
  it("routes supported concepts across English, Spanish and Arabic", () => {
    expect(detectSupervisorIntent("How are we doing today?")).toBe("profitability");
    expect(detectSupervisorIntent("What needs my attention?")).toBe("operating_tasks");
    expect(detectSupervisorIntent("Any staff issues?")).toBe("staff");
    expect(detectSupervisorIntent("Should I change any prices?")).toBe("menu_pricing");
    expect(detectSupervisorIntent("¿Cuánto vendimos hoy?")).toBe("profitability");
    expect(detectSupervisorIntent("¿Qué tareas requieren atención?")).toBe("operating_tasks");
    expect(detectSupervisorIntent("ماذا عن أسعار القائمة؟")).toBe("menu_pricing");
    expect(detectSupervisorIntent("¿Qué tal el clima?")).toBe("unknown");
  });

  it("returns only exact deterministic cents from current-period tools", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const result = await answerSupervisorQuestion({
      text: "How are we doing today?", tools: tools(), state,
    }, copy);
    expect(result.status).toBe("estimated");
    expect(result.blocks.filter((b) => b.type === "metric").map((b) =>
      b.type === "metric" ? b.valueCents : 0)).toEqual([240000, 181952, 58048]);
    expect(result.blocks.some((b) => b.type === "warning" && b.code === "estimated")).toBe(true);
    expect(result.evidence[0].source).toBe("cafe_state");
  });

  it("never shows a number when cost evidence is missing", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const result = await answerSupervisorQuestion({
      text: "How much profit today?", state, tools: tools({
        getProfitability: async () => ({
          available: false, value: null,
          quality: { level: "low", missingInputs: ["cardFees:2026-09-09"], estimatedInputs: [], staleInputs: [] },
        }),
      }),
    }, copy);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.evidence).toEqual([]);
    expect(result.blocks).toEqual([{ type: "warning", code: "insufficient_evidence", text: copy.missingEvidence }]);
  });

  it("queries the actual seven-day calendar window, never today's facts for a week question", async () => {
    const getProfitability = vi.fn(async () => cafeStateFromSnapshot(fixture,
      { from: "2026-09-03", to: "2026-09-09" }).profitability);
    const result = await answerSupervisorQuestion({
      text: "How much profit this week?", tools: tools({ getProfitability }),
      state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(getProfitability).toHaveBeenCalledWith({ from: "2026-09-03", to: "2026-09-09" });
    expect(result.blocks.some((b) => b.type === "text" && b.text === copy.weekOverview)).toBe(true);
  });

  it("refuses yesterday and prior-month requests rather than returning today's money", async () => {
    const getProfitability = vi.fn();
    for (const question of ["What was profit last month?", "What were sales yesterday?", "¿Cuánto vendimos el mes pasado?"]) {
      const result = await answerSupervisorQuestion({
        text: question, tools: tools({ getProfitability }), state: cafeStateFromSnapshot(fixture),
      }, copy);
      expect(result.status).toBe("insufficient_evidence");
      expect(result.blocks).toEqual([{ type: "warning", code: "unsupported_period", text: copy.periodUnavailable }]);
    }
    expect(getProfitability).not.toHaveBeenCalled();
  });

  it("full monthly bills use the Bills budget rather than a prorated snapshot", async () => {
    const { totalMonthlyRecurringCostsCents } = await import("@/lib/expenses/recurringMonthlyTotal");
    const rows = [{ amountCents: 650_000, frequency: "monthly" as const },
      { amountCents: 120_000, frequency: "yearly" as const }];
    const budget = totalMonthlyRecurringCostsCents(rows);
    const getMonthlyBills = vi.fn(async () => ({
      available: true as const, value: { totalCents: budget },
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    }));
    const state = cafeStateFromSnapshot(fixture);
    const answer = await answerSupervisorQuestion({
      text: "What are my monthly bills?", state, tools: tools({ getMonthlyBills }),
    }, copy);
    expect(answer.blocks.find((b) => b.type === "metric")).toMatchObject({
      valueCents: budget, label: "Bills",
    });
    expect(answer.blocks.some((b) => b.type === "text" && b.text.includes("2026-09-30"))).toBe(true);
    expect(getMonthlyBills).toHaveBeenCalledOnce();
  });

  it("uses canonical Money total costs for month-to-date business expenses", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const period = { from: "2026-09-01", to: "2026-09-09" };
    const canonical = cafeStateFromSnapshot(fixture, period).profitability;
    const getProfitability = vi.fn(async () => canonical);
    const answer = await answerSupervisorQuestion({
      text: "Hi, what are my total expenses for the month?", state,
      tools: tools({ getProfitability, getExpenseSummary: vi.fn(() => { throw Error("wrong source"); }) }),
    }, copy);
    expect(getProfitability).toHaveBeenCalledWith(period);
    expect(answer.blocks.find((b) => b.type === "metric")).toMatchObject({
      type: "metric", label: "Costs",
      valueCents: canonical.available ? canonical.value.totalCostsCents : -1,
    });
    expect(answer.blocks.some((b) => b.type === "text" && b.text.includes("2026-09-01 to 2026-09-09"))).toBe(true);
  });

  it("accrues fixed bills but never prorates recorded actual expense entries", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const bills = tools({ getMonthlyBills: async () => ({
      available: true, value: { totalCents: 310_000 },
      quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] },
    }), getRecordedExpenses: async () => ({
      available: true, value: { totalCents: 67_500 },
      quality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] },
    }) });
    const accrued = await answerSupervisorQuestion({
      text: "How much of my fixed bills has accrued so far?", state, tools: bills,
    }, copy);
    expect(accrued.blocks.find((b) => b.type === "metric")).toMatchObject({
      valueCents: 93_000, label: "Accrued bills",
    });
    const actual = await answerSupervisorQuestion({
      text: "How much have I spent so far this month?", state, tools: bills,
    }, copy);
    expect(actual.blocks.find((b) => b.type === "metric")).toMatchObject({
      valueCents: 67_500, label: "Actual expenses",
    });
  });

  it("withholds total costs when canonical financial evidence is incomplete", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const answer = await answerSupervisorQuestion({ state,
      text: "What are my total expenses this month?", tools: tools({
        getProfitability: async () => ({ available: false, value: null,
          quality: { level: "low", missingInputs: ["productCost:missing"], estimatedInputs: [], staleInputs: [] } }),
      }),
    }, copy);
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.blocks.every((b) => b.type !== "metric")).toBe(true);
  });

  it("routes natural language volume, ranking and order questions", () => {
    for (const q of ["How many products am I selling so far?", "How many drinks have I sold today?",
      "Which products sell the most?", "Which products sell the least?", "What is my best-selling drink?",
      "How many coffees did I sell?", "How many orders did we receive today?",
      "¿Cuántos productos he vendido este mes?", "كم مشروب بعت اليوم؟"]) {
      expect(detectSupervisorIntent(q)).toBe("sales_quantity");
    }
  });

  it("does not substitute last-28-day menu quantities for month-to-date units", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const productSales = vi.fn(async () => ({
      available: true as const,
      value: [{ id: "latte", name: "Latte", category: "drink", units: 21 },
        { id: "muffin", name: "Muffin", category: "food", units: 7 }],
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    }));
    const answer = await answerSupervisorQuestion({
      text: "How many products am I selling so far?", state,
      tools: tools({ getSalesTrend: async () => state.sales, getProductSales: productSales }),
    }, copy);
    expect(productSales).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-09" });
    expect(answer.blocks.find((b) => b.type === "count")).toMatchObject({ value: 28, label: "Units" });
    expect(state.products.available && state.products.value[0].quantitySoldLast28Days).toBe(3360);
  });

  it("distinguishes drinks sold from order count and item units", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const getProductSales = vi.fn();
    const scoped = tools({ getSalesTrend: async (dates: { from: string; to: string }) =>
      cafeStateFromSnapshot(fixture, dates).sales, getProductSales });
    const drinks = await answerSupervisorQuestion({ text: "How many drinks sold today?", state, tools: scoped }, copy);
    const orders = await answerSupervisorQuestion({ text: "How many orders today?", state, tools: scoped }, copy);
    expect(drinks.blocks.find((b) => b.type === "count")).toMatchObject({
      value: fixture.todayDay.drinksCount, label: "Drinks",
    });
    expect(orders.blocks.find((b) => b.type === "count")).toMatchObject({
      value: fixture.todayDay.ordersCount, label: "Orders",
    });
    expect(getProductSales).not.toHaveBeenCalled();
  });

  it("uses only verified item-level totals for best and least sellers", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const getProductSales = async () => ({
      available: true as const,
      value: [{ id: "a", name: "Latte", category: "drink" as const, units: 8 },
        { id: "b", name: "Mocha", category: "drink" as const, units: 2 },
        { id: "c", name: "Muffin", category: "food" as const, units: 16 }],
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    });
    const scoped = tools({ getSalesTrend: async () => state.sales, getProductSales });
    const best = await answerSupervisorQuestion({ text: "What's the best-selling drink this month?", state, tools: scoped }, copy);
    const least = await answerSupervisorQuestion({ text: "Which products sell the least this month?", state, tools: scoped }, copy);
    expect(best.blocks.find((b) => b.type === "count")).toMatchObject({ label: "Most: Latte", value: 8 });
    expect(least.blocks.find((b) => b.type === "count")).toMatchObject({ label: "Least: Mocha", value: 2 });
  });

  it("refuses item totals without reliable item-level coverage", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const answer = await answerSupervisorQuestion({
      text: "How many products sold this month?", state,
      tools: tools({ getSalesTrend: async () => state.sales, getProductSales: async () => ({
        available: false, value: null,
        quality: { level: "low", missingInputs: ["itemSalesCoverage"], estimatedInputs: [], staleInputs: [] },
      }) }),
    }, copy);
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.blocks.every((b) => b.type !== "count")).toBe(true);
  });

  it("counts only persisted actionable tasks, not raw signals or inferred actions", async () => {
    const records = [
      { agentId: "alex", status: "needs_owner" },
      { agentId: "maya", status: "needs_response" },
      { agentId: "olivia", status: "watching" },
      { agentId: "leo", status: "handled" },
      { agentId: "maya", status: "expired" },
    ];
    const result = await answerSupervisorQuestion({
      text: "What needs my attention?",
      state: cafeStateFromSnapshot(fixture), tools: tools({
        getTeamTasks: async () => ({ available: true, value: records, quality: {
          level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [],
        } }),
      }),
    }, copy);
    expect(result.status).toBe("verified");
    expect(result.blocks).toEqual([{ type: "text", text: "Needs 2 handled 1 watching 1" }]);
  });

  it("does not report no staff problems when there are no Olivia tasks", async () => {
    const result = await answerSupervisorQuestion({
      text: "Any staff issues?", tools: tools(), state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.blocks).toEqual([{ type: "text", text: copy.staffingNone }]);
  });

  it("does not generate a price without verified canonical pricing results", async () => {
    const result = await answerSupervisorQuestion({
      text: "Should I change latte prices?", tools: tools(), state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.blocks.some((b) => b.type === "metric")).toBe(false);
  });

  it("shows only canonical engine price review numbers and explicit review-only notice", async () => {
    const price = suggestPrice({
      productCostCents: 180, currentPriceCents: 400, productCostStatus: "READY",
      profile: getPricingProfile("ESPRESSO_DRINK"),
      posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0,
        itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 },
      economics: null, categoryPeers: null,
    });
    const state = cafeStateFromSnapshot(fixture, undefined, [{ id: "latte", pricing: price }]);
    const result = await answerSupervisorQuestion({
      text: "Should I change prices?", tools: tools(), state,
    }, copy);
    expect(result.status).toBe("estimated");
    const metrics = result.blocks.filter((b) => b.type === "metric");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      type: "metric", valueCents: price.recommendedPriceCents,
      source: { source: "pricing_engine", identifier: "product:latte" },
    });
    expect(result.evidence.some((e) => e.identifier === "product:latte")).toBe(true);
    expect(result.blocks.some((b) => b.type === "warning" && b.code === "review_only")).toBe(true);
  });

  it("reads only approved owner instructions for the named specialist", async () => {
    const activeRules = [
      { id: "1", agentId: "alex" as const, instruction: "Ask me before recommending changes",
        status: "active" as const, version: 2, createdBy: "owner", reviewedBy: "owner",
        createdAt: "2026-10-10T05:00:00Z", updatedAt: "2026-10-10T06:00:00Z" },
      { id: "2", agentId: "olivia" as const, instruction: "Prefer morning coverage",
        status: "active" as const, version: 2, createdBy: "owner", reviewedBy: "owner",
        createdAt: "2026-10-10T05:00:00Z", updatedAt: "2026-10-10T06:00:00Z" },
      { id: "3", agentId: "alex" as const, instruction: "Do not apply prices",
        status: "draft" as const, version: 1, createdBy: "owner", reviewedBy: null,
        createdAt: "2026-10-10T05:00:00Z", updatedAt: "2026-10-10T06:00:00Z" },
    ];
    const result = await answerSupervisorQuestion({
      text: "What rules have I set for Alex?",
      state: cafeStateFromSnapshot(fixture), tools: tools(), activeRules,
    }, copy);
    expect(result.status).toBe("verified");
    expect(result.evidence).toMatchObject([{ source: "owner_rules" }]);
    expect(result.blocks.some((b) => b.type === "text" &&
      b.text.includes("Ask me before recommending changes"))).toBe(true);
    expect(result.blocks.some((b) => b.type === "text" &&
      b.text.includes("Prefer morning coverage"))).toBe(false);
    expect(result.blocks.some((b) => b.type === "text" &&
      b.text.includes("Do not apply prices"))).toBe(false);
  });

  it("does not invent owner rules when the policy reader is unavailable", async () => {
    const result = await answerSupervisorQuestion({
      text: "Show me my AI rules", state: cafeStateFromSnapshot(fixture),
      tools: tools(), activeRules: null,
    }, copy);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.evidence).toEqual([]);
  });

  it("does not invoke any café tool for an unsupported prompt", async () => {
    const getProfitability = vi.fn();
    const getTeamTasks = vi.fn();
    const result = await answerSupervisorQuestion({
      text: "Tell me a joke about flying", state: cafeStateFromSnapshot(fixture),
      tools: tools({ getProfitability, getTeamTasks }),
    }, copy);
    expect(result.status).toBe("insufficient_evidence");
    expect(getProfitability).not.toHaveBeenCalled();
    expect(getTeamTasks).not.toHaveBeenCalled();
  });
});
