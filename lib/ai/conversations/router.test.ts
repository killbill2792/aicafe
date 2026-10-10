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
  monthlyBillsIntro: "Full month bills",
  totalExpenseIntro: "Monthly bills and actual costs differ",
  spendingIntro: "Recorded payments",
  spendingLabel: "Payments recorded",
  spendingNone: "No payments recorded",
  fullMonthlyBills: "Monthly bill budget",
  operatingCostsSoFar: "Operating costs month to date",
  operatingCostsUnavailable: "Cannot verify full operating costs",
  productUnits: "Mapped menu units",
  itemSalesUnavailable: "Item sales unavailable",
  drinkUnits: "Recorded drinks",
  recordedOrders: "Recorded orders",
  productSalesIntro: "Drinks are not all products",
  productSalesPartial: (observed, expected) => "Recorded " + observed + " of " + expected + " days",
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
  getMonthlyRecurringBills: vi.fn(async () => ({
      available: true as const,
      value: { amountCents: 730012, rows: 8 },
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    })),
    getItemUnitsSold: vi.fn(async () => ({
      available: true as const,
      value: { units: 42, itemsWithSales: 5 },
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    })),
    getRecordedExpenses: vi.fn(async () => ({
      available: true as const,
      value: { amountCents: 125023, rows: 4 },
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    })),
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
    expect(detectSupervisorIntent("How many products am I selling so far?")).toBe("unit_sales");
    expect(detectSupervisorIntent("cuántos productos estoy vendiendo")).toBe("unit_sales");
    expect(detectSupervisorIntent("كم منتج بعت؟")).toBe("unit_sales");
    expect(detectSupervisorIntent("How much have I spent this month?")).toBe("expenses");
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

  it("answers total monthly expenses with FULL recurring bills, never the 10/31 prorated amount", async () => {
    const getMonthlyRecurringBills = vi.fn(async () => ({
      available: true as const, value: { amountCents: 730012, rows: 8 },
      quality: { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] },
    }));
    const getProfitability = vi.fn(async () => ({
      available: false as const, value: null,
      quality: { level: "low" as const, missingInputs: ["salesCoverage"], estimatedInputs: [], staleInputs: [] },
    }));
    const result = await answerSupervisorQuestion({
      text: "hi, what are my total expenses for the month?",
      tools: tools({ getMonthlyRecurringBills, getProfitability }),
      state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.intent).toBe("expenses");
    expect(getMonthlyRecurringBills).toHaveBeenCalledTimes(1);
    expect(getProfitability).toHaveBeenCalledWith({ from: fixture.monthKey+"-01", to: fixture.todayDateStr });
    expect(result.blocks).toContainEqual(expect.objectContaining({
      type: "metric", label: copy.fullMonthlyBills, valueCents: 730012,
    }));
    expect(result.blocks).toContainEqual({
      type: "warning", code: "total_costs_incomplete", text: copy.operatingCostsUnavailable,
    });
    expect(result.blocks.some(b => b.type === "metric" && b.valueCents === 32000)).toBe(false);
  });

  it("monthly bills only uses the same full monthly recurring totals as the Bills page", async () => {
    const getProfitability = vi.fn();
    const result = await answerSupervisorQuestion({
      text: "what are my monthly bills?", state: cafeStateFromSnapshot(fixture),
      tools: tools({ getProfitability }),
    }, copy);
    expect(result.blocks.some(b => b.type === "metric" && b.valueCents === 730012)).toBe(true);
    expect(getProfitability).not.toHaveBeenCalled();
  });

  it("recorded payments are never prorated or confused with projected bills", async () => {
    const result = await answerSupervisorQuestion({
      text: "How much have I spent this month?", tools: tools(),
      state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.blocks).toContainEqual(expect.objectContaining({
      type: "metric", label: copy.spendingLabel, valueCents: 125023,
    }));
    expect(result.blocks.some(b => b.type === "metric" && b.valueCents === 730012)).toBe(false);
  });

  it("explicitly requested accrual preserves the canonical prorated cost model", async () => {
    const result = await answerSupervisorQuestion({
      text: "How much are accrued recurring bills?", tools: tools(),
      state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.blocks.some(b => b.type === "text" && b.text === copy.billsIntro)).toBe(true);
    expect(result.blocks.some(b => b.type === "metric" && b.valueCents === 32000)).toBe(true);
  });

  it("answers product sales as DRINK and ORDER counts, never dollars or invented all-product totals", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const result = await answerSupervisorQuestion({
      text: "how many products am I selling so far",
      tools: tools(), state,
    }, copy);
    expect(result.intent).toBe("unit_sales");
    expect(result.status).toBe("verified");
    const counts = result.blocks.filter(b=>b.type === "count");
    expect(counts).toHaveLength(3);
    expect(counts[0]).toMatchObject({ type: "count",label:"Mapped menu units", value:42 });
    expect(counts[1]).toMatchObject({ type: "count",label:"Recorded drinks" });
    expect(counts[2]).toMatchObject({ type: "count",label:"Recorded orders" });
    expect(result.blocks.some(b=>b.type === "metric")).toBe(false);
    expect(result.blocks.some(b=>b.type === "text" && b.text === copy.productSalesIntro)).toBe(true);
  });

  it("discloses incomplete daily rollups instead of treating missing days as zero sales", async () => {
    const original = cafeStateFromSnapshot(fixture);
    const state = original.sales.available ? {
      ...original, sales: { ...original.sales, value: original.sales.value.slice(1) },
    } : original;
    const result = await answerSupervisorQuestion({ text: "How many products did I sell this month?",
      tools: tools(), state }, copy);
    expect(result.blocks.some(b => b.type === "warning" && b.code === "partial_sales_coverage"))
      .toBe(true);
  });

  it("warns when POS itemization is unavailable while keeping verified drink/order rollups", async () => {
    const result = await answerSupervisorQuestion({
      text: "how many products am I selling so far",
      tools: tools({ getItemUnitsSold: async () => ({
        available: false, value: null,
        quality: { level:"low", missingInputs:["itemizedProductSales"],
          estimatedInputs:[], staleInputs:[] },
      }) }),
      state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.blocks.some(b=>b.type==="warning" && b.code==="itemized_sales_unavailable")).toBe(true);
    expect(result.blocks.filter(b=>b.type==="count")).toHaveLength(2);
  });

  it("never fabricates units from an empty sales period", async () => {
    const state = cafeStateFromSnapshot(fixture);
    const result = await answerSupervisorQuestion({ text: "how many products sold?",
      state: { ...state, sales: { available: false, value: null,
        quality: {level: "low", missingInputs: ["sales"], estimatedInputs:[],staleInputs:[] } } },
      tools: tools() }, copy);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.blocks.some(b=>b.type === "count")).toBe(false);
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
