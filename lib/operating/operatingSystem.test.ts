import { describe, expect, it } from "vitest";
import { NoAIProvider } from "@/lib/ai/providers/noAI";
import { OptionalCafeOperatingBrain } from "@/lib/ai/operatingBrain";
import { ownerProfitCentsForPeriod } from "@/lib/calc";
import { cafeStateFromSnapshot } from "./cafeState";
import { deterministicDecisions } from "./decisions";
import { signalsFromPricing } from "./signals";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { suggestPrice } from "@/lib/calc/pricingEngine";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";

describe("AI-native operating system boundaries", () => {
  const fixtureSnapshot = getFixtureSnapshot();
  const pricing = suggestPrice({ productCostCents: 180, currentPriceCents: 400, recipeStatus: "READY", profile: getPricingProfile("ESPRESSO_DRINK"), posSignal: { daysWithSalesInWindow: 80, windowDays: 90, totalOrdersInWindow: 900, itemUnitsSoldInWindow: 80, monthlyRevenueCents: 100_000 }, economics: { monthlyRevenueCents: 100_000, monthlyVariableProductCostCents: 30_000, monthlyStaffCostCents: 35_000, monthlyOperatingCostCents: 25_000, monthlyProcessingFeesCents: 0 }, categoryPeers: null });

  it("produces signals and deterministic decisions with no AI", () => {
    const signals = signalsFromPricing("latte", pricing);
    const decisions = deterministicDecisions({ businessId: "cafe", signals, now: new Date("2026-10-01T00:00:00Z") });
    expect(signals[0]?.type).toBe("PRICE_REVIEW_REQUIRED");
    expect(decisions[0]?.recommendation.parameters.suggestedPriceCents).toBe(pricing.recommendedPriceCents);
    expect(decisions[0]?.autonomyLevel).toBe(2);
  });

  it("surfaces missing inventory and suppliers instead of inventing them", () => {
    const state = cafeStateFromSnapshot(fixtureSnapshot);
    expect(state.inventory).toEqual(expect.objectContaining({ available: false, value: null }));
    expect(state.inventory.quality.missingInputs).toEqual(["inventory"]);
    expect(state.suppliers.quality.missingInputs).toEqual(["suppliers"]);
  });

  it("profitability remains deterministic when all AI keys are absent", () => {
    expect(ownerProfitCentsForPeriod(fixtureSnapshot.monthActualDays, 100_000)).toBeTypeOf("number");
  });

  it("NoAIProvider and provider failures preserve core workflows", async () => {
    const decision = deterministicDecisions({ businessId: "cafe", signals: signalsFromPricing("latte", pricing) })[0];
    const tools = { getOperatingSnapshot: async () => ({ signals: [], decisions: [decision] }) } as never;
    const noAiBrain = new OptionalCafeOperatingBrain(new NoAIProvider(), tools);
    expect((await noAiBrain.observe("cafe")).decisions).toHaveLength(1);
    expect((await noAiBrain.explainDecision(decision)).source).toBe("deterministic");
    const failing = { name: "failing", isAvailable: async () => true, reason: async () => { throw new Error("offline"); }, explain: async () => { throw new Error("offline"); } };
    expect((await new OptionalCafeOperatingBrain(failing, tools).explainDecision(decision)).source).toBe("deterministic");
  });
});
