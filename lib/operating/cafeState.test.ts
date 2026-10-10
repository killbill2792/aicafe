import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import type { BusinessSnapshot } from "@/lib/data/types";
import { suggestPrice } from "@/lib/calc/pricingEngine";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { SnapshotCafeStateService, cafeStateFromSnapshot } from "./cafeState";

const fixture = getFixtureSnapshot();

describe("Phase 2 snapshot-to-CafeState truth boundary", () => {
  it("reconciles Fixture A month-to-date to existing Home/Money cost math", () => {
    const state = cafeStateFromSnapshot(fixture);
    expect(state.period).toEqual({ from: "2026-09-01", to: "2026-09-09" });
    expect(state.profitability.available).toBe(true);
    if (!state.profitability.available) return;
    expect(state.profitability.value).toMatchObject({
      netSalesCents: 2_160_000,
      totalCostsCents: 1_637_568,
      ownerProfitCents: 522_432,
      coveredSalesDays: 9,
      expectedSalesDays: 9,
    });
    expect(state.profitability.quality.estimatedInputs).toContain("expense:utilities_power");
  });

  it("prorates monthly bills to one day and preserves known cents", () => {
    const state = cafeStateFromSnapshot(fixture, { from: "2026-09-09", to: "2026-09-09" });
    expect(state.profitability.available).toBe(true);
    if (state.profitability.available) {
      expect(state.profitability.value.netSalesCents).toBe(240_000);
      expect(state.profitability.value.ownerProfitCents).toBe(58_048);
      expect(state.profitability.value.totalCostsCents).toBe(181_952);
    }
  });

  it("does not treat uncovered sales dates as zero sales or a verified profit", () => {
    const snapshot = { ...fixture, monthActualDays: fixture.monthActualDays.slice(0, 8) };
    const state = cafeStateFromSnapshot(snapshot);
    expect(state.sales.available).toBe(true);
    expect(state.sales.quality.missingInputs).toContain("salesCoverage:8/9");
    expect(state.profitability.available).toBe(false);
    expect(state.profitability.quality.missingInputs).toContain("salesCoverage:8/9");
  });

  it("does not invent a prior-month expense history or a cross-month running cost", () => {
    const state = cafeStateFromSnapshot(fixture, { from: "2026-08-31", to: "2026-09-09" });
    expect(state.sales.available).toBe(false);
    expect(state.expenses.available).toBe(false);
    expect(state.profitability.available).toBe(false);
    expect(state.profitability.quality.missingInputs).toContain("periodOutsideLoadedMonth");
  });

  it("refuses future dates or invalid calendars", () => {
    expect(cafeStateFromSnapshot(fixture, { from: "2026-09-09", to: "2026-09-10" }).profitability.available).toBe(false);
    expect(cafeStateFromSnapshot(fixture, { from: "2026-09-31", to: "2026-09-31" }).profitability.available).toBe(false);
  });

  it("refuses financial certainty when processing fees are missing", () => {
    const snapshot = {
      ...fixture,
      monthActualDays: fixture.monthActualDays.map((day, i) => i === 0
        ? { ...day, cardFeesStatus: "missing" as const } : day),
    };
    const state = cafeStateFromSnapshot(snapshot);
    expect(state.profitability.available).toBe(false);
    expect(state.profitability.quality.missingInputs).toContain("cardFees:2026-09-01");
  });

  it("keeps estimated card fees, payroll tax and product costs labeled", () => {
    const snapshot: BusinessSnapshot = {
      ...fixture,
      monthActualDays: fixture.monthActualDays.map((day, i) => i === 0
        ? { ...day, cardFeesStatus: "estimated", staffTaxStatus: "estimated" } : day),
      monthRecordedDays: fixture.monthActualDays.map((day, i) => i === 0
        ? { ...day, cardFeesStatus: "estimated", staffTaxStatus: "estimated" } : day),
      menuItems: fixture.menuItems.map((item, i) => i === 0 ? { ...item, costQuality: "estimated" } : item),
    };
    const state = cafeStateFromSnapshot(snapshot);
    expect(state.profitability.available).toBe(true);
    expect(state.profitability.quality.estimatedInputs).toEqual(expect.arrayContaining([
      "cardFees:2026-09-01", "staffTax:2026-09-01", "productCost:latte",
    ]));
  });

  it("blocks profitability when a sold item has unknown product cost", () => {
    const snapshot: BusinessSnapshot = {
      ...fixture,
      menuItems: [{ ...fixture.menuItems[0], costStatus: "NO_RECIPE" }, ...fixture.menuItems.slice(1)],
    };
    const state = cafeStateFromSnapshot(snapshot);
    expect(state.profitability.available).toBe(false);
    expect(state.profitability.quality.missingInputs).toContain("productCost:latte");
  });

  it("blocks profitability when an expected bill is missing", () => {
    const snapshot: BusinessSnapshot = {
      ...fixture,
      runningCostLines: [
        ...fixture.runningCostLines,
        { categoryCode: "internet", label: "Internet", amountCents: 0, isEstimate: false, isMissing: true, isExpected: true },
      ],
    };
    const state = cafeStateFromSnapshot(snapshot);
    expect(state.profitability.available).toBe(false);
    expect(state.profitability.quality.missingInputs).toContain("expense:internet");
  });

  it("keeps staff-only rollups available, without inventing sales for that day", () => {
    const snapshot: BusinessSnapshot = {
      ...fixture,
      monthActualDays: fixture.monthActualDays.slice(1),
      monthRecordedDays: fixture.monthActualDays,
    };
    const state = cafeStateFromSnapshot(snapshot);
    expect(state.sales.quality.missingInputs).toContain("salesCoverage:8/9");
    expect(state.labor.available).toBe(true);
    if (state.labor.available) {
      expect(state.labor.value).toHaveLength(9);
      expect(state.labor.value[0].loadedStaffCostCents).toBe(77_952);
    }
  });

  it("retains missing inventory, suppliers and pricing without a verified loader", () => {
    const state = cafeStateFromSnapshot(fixture);
    expect(state.inventory.quality.missingInputs).toEqual(["inventory"]);
    expect(state.suppliers.quality.missingInputs).toEqual(["suppliers"]);
    expect(state.pricingRecommendations.available).toBe(false);
  });

  it("accepts only canonical price-engine results for items in this café", () => {
    const result = suggestPrice({
      productCostCents: 180, currentPriceCents: 400, productCostStatus: "READY",
      profile: getPricingProfile("ESPRESSO_DRINK"),
      posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 },
      economics: null, categoryPeers: null,
    });
    const state = cafeStateFromSnapshot(fixture, undefined, [
      { id: "latte", pricing: result },
      { id: "from-another-cafe", pricing: result },
      { id: "drip", pricing: null },
    ]);
    expect(state.pricingRecommendations.available).toBe(true);
    if (state.pricingRecommendations.available) {
      expect(state.pricingRecommendations.value.latte).toBe(result);
      expect(state.pricingRecommendations.value["from-another-cafe"]).toBeUndefined();
      expect(state.pricingRecommendations.value.drip).toBeUndefined();
    }
  });

  it("rejects a snapshot from another business before loading pricing", async () => {
    let pricingCalls = 0;
    const service = new SnapshotCafeStateService(async () => fixture, async () => {
      pricingCalls++;
      return [];
    });
    await expect(service.getCurrentState("another-cafe")).rejects.toThrow("business mismatch");
    expect(pricingCalls).toBe(0);
  });

  it("does not describe today's pricing recommendation as historical", async () => {
    let pricingCalls = 0;
    const service = new SnapshotCafeStateService(async () => fixture, async () => {
      pricingCalls++;
      return [];
    });
    const historical = await service.getHistoricalState("fixture-a", { from: "2026-09-01", to: "2026-09-09" });
    expect(historical.pricingRecommendations.available).toBe(false);
    expect(pricingCalls).toBe(0);
  });
});
