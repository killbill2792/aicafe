import { describe, expect, it } from "vitest";
import { simulateProfitGoal } from "./profitGoalSimulator";

const economics = {
  monthlyRevenueCents: 100_000,
  monthlyVariableProductCostCents: 25_000,
  monthlyStaffCostCents: 25_000,
  monthlyOperatingCostCents: 20_000,
  monthlyProcessingFeesCents: 3_000,
};

const item = {
  id: "one",
  name: "Example",
  currentPriceCents: 2_300,
  productCostCents: 600,
  recipeStatus: "READY" as const,
  unitsSoldInWindow: 50,
};

describe("profit goal simulator", () => {
  it("changes when the target changes and does not apply the old 15% cap", () => {
    const twenty = simulateProfitGoal({ economics, targetOperatingMargin: 0.20, items: [item] });
    const forty = simulateProfitGoal({ economics, targetOperatingMargin: 0.40, items: [item] });
    expect(twenty.kind).toBe("ready");
    expect(forty.kind).toBe("ready");
    if (twenty.kind !== "ready" || forty.kind !== "ready") return;
    expect(forty.revenueMultiplier).toBeGreaterThan(twenty.revenueMultiplier);
    expect(forty.items[0].simulatedPriceCents).toBeGreaterThan(twenty.items[0].simulatedPriceCents!);
    expect(forty.requiredPriceIncreasePercent).toBeGreaterThan(15);
    expect(forty.largeChange).toBe(true);
  });

  it("never lowers an existing price when the café already exceeds the target", () => {
    const strongEconomics = {
      ...economics,
      monthlyVariableProductCostCents: 10_000,
      monthlyStaffCostCents: 10_000,
      monthlyOperatingCostCents: 10_000,
    };
    const result = simulateProfitGoal({
      economics: strongEconomics,
      targetOperatingMargin: 0.15,
      items: [item],
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.revenueMultiplier).toBe(1);
    expect(result.items[0].simulatedPriceCents).toBe(2_300);
  });

  it("keeps the current $23 price even though $6 / 30% would be $20", () => {
    const result = simulateProfitGoal({ economics, targetOperatingMargin: 0.10, items: [item] });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.items[0].productCostPercent).toBeCloseTo(600 / 2300);
    expect(result.items[0].simulatedPriceCents).toBe(2_300);
  });
});
