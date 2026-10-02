import { describe, expect, it } from "vitest";
import { groupMenuCatalogItems, isPricingHealthy } from "./menuCatalogViewModel";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import type { PricingResult } from "@/lib/calc";

const HEALTHY_PRICING: PricingResult = {
  productCostCents: 100,
  baselinePriceCents: 500,
  calculatedSuggestedPriceCents: 500,
  currentPriceCents: 500,
  recommendedPriceCents: 500,
  calculationMode: "BENCHMARK",
  businessAdjustmentFactor: 1,
  confidence: "HIGH",
  status: "KEEP_CURRENT_PRICE",
  explanationCode: "BENCHMARK_EXPLAINER",
  assumptions: [],
  signals: [],
  explanationInputs: {},
  dataQuality: {} as PricingResult["dataQuality"],
  warnings: [],
};

const REVIEW_PRICING: PricingResult = { ...HEALTHY_PRICING, status: "REVIEW_PRICE", recommendedPriceCents: 600 };

function makeItem(overrides: Partial<MenuControlItem> & { id: string }): MenuControlItem {
  return {
    name: overrides.name ?? "Item",
    baseName: overrides.baseName ?? "Item",
    sizeLabel: overrides.sizeLabel ?? null,
    priceCents: overrides.priceCents ?? 500,
    prepSeconds: 60,
    category: "ESPRESSO_DRINK",
    menuGroup: overrides.menuGroup ?? "Coffee",
    active: overrides.active ?? true,
    posItemId: null,
    catalogSource: "manual",
    catalogLastSyncedAt: null,
    recipe: [],
    ingredientsCostCents: 100,
    costStatus: overrides.costStatus ?? "READY",
    missingCostIngredientNames: [],
    pricing: overrides.pricing !== undefined ? overrides.pricing : HEALTHY_PRICING,
    unitsSold: null,
    revenueCents: null,
    provenance: "MANUAL",
    lastSyncedAt: null,
    ...overrides,
  };
}

describe("groupMenuCatalogItems", () => {
  it("groups same-baseName active sizes into one row, cheapest first", () => {
    const items = [
      makeItem({ id: "latte-16", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500 }),
      makeItem({ id: "latte-12", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400 }),
    ];
    const groups = groupMenuCatalogItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].baseName).toBe("Latte");
    expect(groups[0].sizeLabels).toEqual(["12 oz", "16 oz"]);
    expect(groups[0].fromPriceCents).toBe(400);
    expect(groups[0].representativeItem.id).toBe("latte-12");
    expect(groups[0].isSingleSize).toBe(false);
  });

  it("leaves a single-size item as its own one-member group", () => {
    const items = [makeItem({ id: "milk", baseName: "Milk", sizeLabel: null, priceCents: 300 })];
    const groups = groupMenuCatalogItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].isSingleSize).toBe(true);
    expect(groups[0].sizeLabels).toEqual([]);
    expect(groups[0].fromPriceCents).toBe(300);
  });

  it("never mixes active and archived sizes of the same product", () => {
    const items = [
      makeItem({ id: "latte-active", baseName: "Latte", sizeLabel: "12 oz", active: true }),
      makeItem({ id: "latte-archived", baseName: "Latte", sizeLabel: "16 oz", active: false }),
    ];
    const groups = groupMenuCatalogItems(items);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.active)?.memberIds).toEqual(["latte-active"]);
    expect(groups.find((g) => !g.active)?.memberIds).toEqual(["latte-archived"]);
  });

  it("flags the whole group as needing attention when any one size does, even if others are healthy", () => {
    const items = [
      makeItem({ id: "latte-12", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400, pricing: HEALTHY_PRICING }),
      makeItem({ id: "latte-16", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500, pricing: REVIEW_PRICING }),
    ];
    const groups = groupMenuCatalogItems(items);
    expect(groups[0].needsAttention).toBe(true);
  });

  it("marks the group healthy only when every size is healthy", () => {
    const items = [
      makeItem({ id: "latte-12", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400, pricing: HEALTHY_PRICING }),
      makeItem({ id: "latte-16", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500, pricing: HEALTHY_PRICING }),
    ];
    const groups = groupMenuCatalogItems(items);
    expect(groups[0].needsAttention).toBe(false);
  });

  it("breaks ties on equal price deterministically by id", () => {
    const items = [
      makeItem({ id: "b-size", baseName: "Latte", sizeLabel: "B", priceCents: 500 }),
      makeItem({ id: "a-size", baseName: "Latte", sizeLabel: "A", priceCents: 500 }),
    ];
    const groups = groupMenuCatalogItems(items);
    expect(groups[0].representativeItem.id).toBe("a-size");
  });

  it("preserves first-seen product order", () => {
    const items = [
      makeItem({ id: "croissant", baseName: "Croissant", priceCents: 350 }),
      makeItem({ id: "latte-12", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400 }),
      makeItem({ id: "latte-16", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500 }),
    ];
    const groups = groupMenuCatalogItems(items);
    expect(groups.map((g) => g.baseName)).toEqual(["Croissant", "Latte"]);
  });
});

describe("isPricingHealthy", () => {
  it("is false when the recipe isn't ready, regardless of pricing", () => {
    expect(isPricingHealthy({ costStatus: "NO_RECIPE", pricing: HEALTHY_PRICING })).toBe(false);
  });

  it("is false when pricing is unavailable", () => {
    expect(isPricingHealthy({ costStatus: "READY", pricing: null })).toBe(false);
    expect(isPricingHealthy({ costStatus: "READY", pricing: { ...HEALTHY_PRICING, status: "PRICE_UNAVAILABLE", recommendedPriceCents: null } })).toBe(false);
  });

  it("is true only when the current price already matches the recommendation", () => {
    expect(isPricingHealthy({ costStatus: "READY", pricing: HEALTHY_PRICING })).toBe(true);
    expect(isPricingHealthy({ costStatus: "READY", pricing: REVIEW_PRICING })).toBe(false);
  });
});
