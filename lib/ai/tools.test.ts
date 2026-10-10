import { describe, expect, it, vi } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { SnapshotCafeStateService } from "@/lib/operating/cafeState";
import type { DecisionStore } from "@/lib/operating/decisions";
import { BusinessScopedCafeTools, StructuredCafeTools } from "./tools";

const fixture = getFixtureSnapshot();
const period = { from: "2026-09-01", to: "2026-09-09" };
const fakeDecisions: DecisionStore = {
  getDecisionHistory: async () => [],
  getOutcomes: async () => [],
  saveDecision: async () => { throw new Error("writes forbidden"); },
  saveOutcome: async () => { throw new Error("writes forbidden"); },
};

function makeTools(snapshot = fixture) {
  return new StructuredCafeTools(
    new SnapshotCafeStateService(async () => snapshot),
    fakeDecisions,
    async () => [],
  );
}

describe("StructuredCafeTools read-only evidence boundary", () => {
  it("returns verified typed profit without recreating business math", async () => {
    const result = await makeTools().getProfitability("fixture-a", period);
    expect(result.available).toBe(true);
    if (result.available) expect(result.value.ownerProfitCents).toBe(522_432);
  });

  it("returns a known product's canonical cost with provenance", async () => {
    const result = await makeTools().getProductEconomics("fixture-a", "latte");
    expect(result.available).toBe(true);
    if (result.available) expect(result.value.ingredientsCentsToday).toBe(95);
  });

  it("does not return a fake zero-priced item when product is unknown", async () => {
    const result = await makeTools().getProductEconomics("fixture-a", "no-such-product");
    expect(result.available).toBe(false);
    expect(result.quality.missingInputs).toEqual(["product:no-such-product"]);
  });

  it("returns unavailable pricing when no canonical engine loader is wired", async () => {
    const result = await makeTools().getPricingRecommendation("fixture-a", "latte");
    expect(result.available).toBe(false);
    expect(result.quality.missingInputs).toContain("pricingRecommendations");
  });

  it("does not call current recurring bills an expense change", async () => {
    const tools = makeTools();
    const changes = await tools.getExpenseChanges("fixture-a", period);
    const summary = await tools.getExpenseSummary("fixture-a", period);
    expect(changes.available).toBe(false);
    expect(changes.quality.missingInputs).toEqual(["previousExpenseHistory"]);
    expect(summary.available).toBe(true);
  });

  it("rejects a sales trend with gaps rather than claiming zero-sales days", async () => {
    const tools = makeTools({ ...fixture, monthActualDays: fixture.monthActualDays.slice(1) });
    const result = await tools.getSalesTrend("fixture-a", period);
    expect(result.available).toBe(false);
    expect(result.quality.missingInputs).toContain("salesCoverage:8/9");
  });

  it("includes staff daily numbers from existing loaded timecard rollups", async () => {
    const result = await makeTools().getLaborMetrics("fixture-a", period);
    expect(result.available).toBe(true);
    if (result.available) expect(result.value[0].loadedStaffCostCents).toBe(77_952);
  });

  it("exposes inventory as unavailable, never assumed in-stock", async () => {
    const result = await makeTools().getInventoryStatus("fixture-a");
    expect(result).toMatchObject({ available: false, value: null });
  });

  it("refuses cross-tenant decisions even from a faulty decision reader", async () => {
    const badStore = { ...fakeDecisions, getDecisionHistory: async () => [{ businessId: "other" }] };
    const tools = new StructuredCafeTools(
      new SnapshotCafeStateService(async () => fixture),
      badStore as unknown as DecisionStore,
      async () => [],
    );
    await expect(tools.getDecisionHistory("fixture-a")).rejects.toThrow("business mismatch");
  });

  it("binds every future Supervisor read to the authenticated business identity", async () => {
    const getProfitability = vi.fn(async (id: string) => ({ id }));
    const getPricingRecommendation = vi.fn(async (id: string) => ({ id }));
    const scoped = new BusinessScopedCafeTools({
      getProfitability, getPricingRecommendation,
    } as unknown as StructuredCafeTools, "fixture-a");
    await scoped.getProfitability(period);
    await scoped.getPricingRecommendation("latte");
    expect(getProfitability).toHaveBeenCalledWith("fixture-a", period);
    expect(getPricingRecommendation).toHaveBeenCalledWith("fixture-a", "latte");
  });

  it("does not permit creating a business-scoped reader with no business ID", () => {
    expect(() => new BusinessScopedCafeTools(makeTools(), "")).toThrow("Missing authorized café");
  });
});
