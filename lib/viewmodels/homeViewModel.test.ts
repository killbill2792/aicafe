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
});
