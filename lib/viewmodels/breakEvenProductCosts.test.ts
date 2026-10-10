import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { buildCostRecoveryViewModel } from "./moneyViewModel";
import { buildBreakEvenViewModel } from "./breakEvenViewModel";

describe("break-even resolved product costs", () => {
  it("uses owner-total resolved costs instead of recipe-only rollup ingredients", () => {
    const snapshot = getFixtureSnapshot();
    const sold = 100;
    const costPerItem = 150;
    snapshot.menuItems = [{
      id: "fallback-item",
      name: "Latte",
      priceCents: 600,
      prepSeconds: 60,
      category: "drink",
      ingredientsCentsToday: costPerItem,
      hasRecipe: false,
      costStatus: "READY",
      costSource: "owner_total",
      recipeCostCents: null,
      recipeCostStatus: "NO_RECIPE",
      ownerTotalCostCents: costPerItem,
      costDifferenceCents: null,
      quantitySoldLast28Days: sold,
    }];

    const observedSales = snapshot.last28Days.reduce((sum, day) => sum + day.netSalesCents, 0);
    const expectedRate = (sold * costPerItem) / observedSales;
    const vm = buildCostRecoveryViewModel(snapshot);
    expect(vm.breakEven.kind).toBe("ready");
    if (vm.breakEven.kind === "ready") expect(vm.breakEven.ingredientRate).toBeCloseTo(expectedRate, 8);
  });

  it("refuses break-even when a sold item still has no resolved product cost", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.menuItems = [{
      id: "missing-item",
      name: "Mystery drink",
      priceCents: 600,
      prepSeconds: 60,
      category: "drink",
      ingredientsCentsToday: 0,
      hasRecipe: false,
      costStatus: "NO_RECIPE",
      costSource: null,
      recipeCostCents: null,
      recipeCostStatus: "NO_RECIPE",
      ownerTotalCostCents: null,
      costDifferenceCents: null,
      quantitySoldLast28Days: 20,
    }];
    expect(buildCostRecoveryViewModel(snapshot).breakEven).toEqual({ kind: "unavailable", reason: "MISSING_PRODUCT_COSTS" });
    expect(buildBreakEvenViewModel(snapshot).unavailableReason).toBe("missing_product_costs");
  });
});
