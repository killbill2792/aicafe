import { describe, expect, it } from "vitest";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { buildHomeViewModel } from "./homeViewModel";
import { buildBreakEvenViewModel } from "./breakEvenViewModel";

describe("owner-truthful Home inputs", () => {
  it("does not block break-even for an unused Repairs category", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.runningCostLines.push({ categoryCode: "repairs", label: "Repairs", amountCents: 0, isEstimate: false, isMissing: false, isExpected: false });
    expect(buildHomeViewModel(snapshot, "month").breakEvenUnavailableReason).toBeNull();
    expect(buildBreakEvenViewModel(snapshot).unavailableReason).toBeNull();
  });

  it("excludes a partially priced recipe from contribution ranking", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.menuItems.push({ id: "partial", name: "Partially priced", priceCents: 50_000, prepSeconds: 1, category: "drink", ingredientsCentsToday: 1, hasRecipe: true, costStatus: "MISSING_INGREDIENT_COST", quantitySoldLast28Days: 1 });
    expect(buildHomeViewModel(snapshot, "month").bestItem?.id).not.toBe("partial");
  });

  it("does not calculate what-if targets when recent sales are missing", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.last28Days = [];
    const vm = buildBreakEvenViewModel(snapshot);
    expect(vm.unavailableReason).toBe("missing_sales");
    expect(vm.whatIfs).toEqual([]);
  });

  it("does not calculate what-if targets when an expected cost is missing", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.runningCostLines.push({ categoryCode: "water", label: "Water", amountCents: 0, isEstimate: false, isMissing: true, isExpected: true });
    const vm = buildBreakEvenViewModel(snapshot);
    expect(vm.unavailableReason).toBe("missing_costs");
    expect(vm.whatIfs).toEqual([]);
    expect(vm.missingCosts[0]?.categoryCode).toBe("water");
  });

  it("recognizes a fresh café without sales or known running-cost setup", () => {
    const snapshot = getFixtureSnapshot();
    snapshot.last28Days = [];
    snapshot.runningCostLines = snapshot.runningCostLines.map((line) => ({ ...line, amountCents: 0, isMissing: false, isExpected: false }));
    expect(buildHomeViewModel(snapshot, "month").isGettingStarted).toBe(true);
  });
});
