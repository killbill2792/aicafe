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
  sales: "Sales",
  totalCosts: "Costs",
  ownerProfit: "Owner profit",
  recurringBills: "Bills",
  billsIntro: "These are recurring bills",
  pricingIntro: "Review products",
  pricingNone: "No recorded pricing reviews",
  pricingUnavailable: "Pricing unavailable",
  pricingCaution: "Review only",
  priceLabel: (name) => "Review " + name,
  tasks: (n, h, w) => "Needs " + n + " handled " + h + " watching " + w,
  staffingTasks: (n) => "Olivia has " + n + " open tasks",
  staffingNone: "No open Olivia tasks recorded",
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

  it("distinguishes period-prorated recurring bills from total costs", async () => {
    const result = await answerSupervisorQuestion({
      text: "What are our rent and bills?", tools: tools(),
      state: cafeStateFromSnapshot(fixture),
    }, copy);
    expect(result.intent).toBe("expenses");
    expect(result.blocks.some((b) => b.type === "text" && b.text === copy.billsIntro)).toBe(true);
    const metric = result.blocks.find((b) => b.type === "metric");
    expect(metric && metric.type === "metric" && metric.valueCents).toBe(32000);
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
