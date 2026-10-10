import { describe, expect, it } from "vitest";
import { getItemPricingStatus, groupMenuCatalogItems, isPricingHealthy } from "./menuCatalogViewModel";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import type { PricingResult } from "@/lib/calc";

function pricing(overrides: Partial<PricingResult>): PricingResult {
  return {
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
    ...overrides,
  };
}

const HEALTHY_PRICING = pricing({});
const LOW_PRICING = pricing({ status: "REVIEW_PRICE", currentPriceCents: 1500, recommendedPriceCents: 1875 });
const HIGH_PRICING = pricing({ status: "REVIEW_PRICE", currentPriceCents: 2000, recommendedPriceCents: 1225 });

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
    costSource: "recipe",
    recipeCostCents: 100,
    recipeCostStatus: overrides.costStatus ?? "READY",
    ownerTotalCostCents: null,
    ownerTotalCostStatus: null,
    ownerTotalCostSource: null,
    costDifferenceCents: null,
    missingCostIngredientNames: [],
    pricing: overrides.pricing !== undefined ? overrides.pricing : HEALTHY_PRICING,
    unitsSold: null,
    revenueCents: null,
    provenance: "MANUAL",
    lastSyncedAt: null,
    ...overrides,
  };
}

describe("getItemPricingStatus", () => {
  it("is incomplete_recipe when the recipe isn't ready, regardless of pricing", () => {
    expect(getItemPricingStatus({ costStatus: "NO_RECIPE", pricing: HEALTHY_PRICING }).kind).toBe("incomplete_recipe");
    expect(getItemPricingStatus({ costStatus: "MISSING_INGREDIENT_COST", pricing: HEALTHY_PRICING }).kind).toBe("incomplete_recipe");
  });

  it("is price_unavailable when pricing itself has nothing usable", () => {
    expect(getItemPricingStatus({ costStatus: "READY", pricing: null }).kind).toBe("price_unavailable");
    expect(getItemPricingStatus({ costStatus: "READY", pricing: pricing({ status: "PRICE_UNAVAILABLE", recommendedPriceCents: null }) }).kind).toBe("price_unavailable");
  });

  it("is keep only when the current price already matches the recommendation", () => {
    expect(getItemPricingStatus({ costStatus: "READY", pricing: HEALTHY_PRICING }).kind).toBe("keep");
  });

  it("is low when the suggested price is above what the owner charges", () => {
    const status = getItemPricingStatus({ costStatus: "READY", pricing: LOW_PRICING });
    expect(status).toEqual({ kind: "low", suggestedPriceCents: 1875 });
  });

  it("is high when the suggested price is below what the owner charges", () => {
    const status = getItemPricingStatus({ costStatus: "READY", pricing: HIGH_PRICING });
    expect(status).toEqual({ kind: "high", suggestedPriceCents: 1225 });
  });
});

describe("isPricingHealthy", () => {
  it("mirrors getItemPricingStatus's keep case exactly", () => {
    expect(isPricingHealthy({ costStatus: "READY", pricing: HEALTHY_PRICING })).toBe(true);
    expect(isPricingHealthy({ costStatus: "READY", pricing: LOW_PRICING })).toBe(false);
    expect(isPricingHealthy({ costStatus: "NO_RECIPE", pricing: HEALTHY_PRICING })).toBe(false);
  });
});

describe("groupMenuCatalogItems", () => {
  it("one size, healthy — a single-size group with all_healthy status", () => {
    const groups = groupMenuCatalogItems([makeItem({ id: "a", baseName: "Latte", priceCents: 500, pricing: HEALTHY_PRICING })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isSingleSize).toBe(true);
    expect(groups[0].pricingStatus).toEqual({ kind: "all_healthy" });
    expect(groups[0].priceRange).toEqual({ minCents: 500, maxCents: 500, allSame: true });
  });

  it("one size, price may be low", () => {
    const groups = groupMenuCatalogItems([makeItem({ id: "a", baseName: "Americano", sizeLabel: "16 oz", priceCents: 1500, pricing: LOW_PRICING })]);
    expect(groups[0].pricingStatus).toEqual({ kind: "needs_review_one", sizeLabel: "16 oz", direction: "low", suggestedPriceCents: 1875 });
  });

  it("one size, price may be high", () => {
    const groups = groupMenuCatalogItems([makeItem({ id: "a", baseName: "Macchiato", sizeLabel: null, priceCents: 2000, pricing: HIGH_PRICING })]);
    expect(groups[0].pricingStatus).toEqual({ kind: "needs_review_one", sizeLabel: null, direction: "high", suggestedPriceCents: 1225 });
  });

  it("two sizes, both healthy", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400, pricing: HEALTHY_PRICING }),
      makeItem({ id: "b", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500, pricing: HEALTHY_PRICING }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isSingleSize).toBe(false);
    expect(groups[0].pricingStatus).toEqual({ kind: "all_healthy" });
  });

  it("one of two sizes needs review — names the size and the direction", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Americano", sizeLabel: "16 oz", priceCents: 1500, pricing: LOW_PRICING }),
      makeItem({ id: "b", baseName: "Americano", sizeLabel: "20 oz", priceCents: 1800, pricing: HEALTHY_PRICING }),
    ]);
    expect(groups[0].pricingStatus).toEqual({ kind: "needs_review_one", sizeLabel: "16 oz", direction: "low", suggestedPriceCents: 1875 });
  });

  it("both sizes need review — does not fabricate one suggested price, just a count", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Americano", sizeLabel: "16 oz", priceCents: 1500, pricing: LOW_PRICING }),
      makeItem({ id: "b", baseName: "Americano", sizeLabel: "20 oz", priceCents: 2000, pricing: HIGH_PRICING }),
    ]);
    expect(groups[0].pricingStatus).toEqual({ kind: "needs_review_many", count: 2 });
  });

  it("missing recipe on one size takes priority over any pricing-review message", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400, costStatus: "NO_RECIPE", pricing: null }),
      makeItem({ id: "b", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500, pricing: LOW_PRICING }),
    ]);
    expect(groups[0].pricingStatus).toEqual({ kind: "missing_recipe_one", sizeLabel: "12 oz" });
  });

  it("missing cost info (not a bare missing recipe) reports a count instead of naming the size", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400, costStatus: "MISSING_INGREDIENT_COST", pricing: null }),
    ]);
    expect(groups[0].pricingStatus).toEqual({ kind: "missing_data", count: 1 });
  });

  it("two incomplete sizes report a count even if one is a bare missing recipe", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Latte", sizeLabel: "12 oz", priceCents: 400, costStatus: "NO_RECIPE", pricing: null }),
      makeItem({ id: "b", baseName: "Latte", sizeLabel: "16 oz", priceCents: 500, costStatus: "MISSING_INGREDIENT_COST", pricing: null }),
    ]);
    expect(groups[0].pricingStatus).toEqual({ kind: "missing_data", count: 2 });
  });

  it("same price across sizes shows allSame true", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Croissant", sizeLabel: "Plain", priceCents: 350 }),
      makeItem({ id: "b", baseName: "Croissant", sizeLabel: "Almond", priceCents: 350 }),
    ]);
    expect(groups[0].priceRange).toEqual({ minCents: 350, maxCents: 350, allSame: true });
  });

  it("different prices across sizes report the real min/max range", () => {
    const groups = groupMenuCatalogItems([
      makeItem({ id: "a", baseName: "Americano", sizeLabel: "16 oz", priceCents: 1500 }),
      makeItem({ id: "b", baseName: "Americano", sizeLabel: "20 oz", priceCents: 1800 }),
    ]);
    expect(groups[0].priceRange).toEqual({ minCents: 1500, maxCents: 1800, allSame: false });
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
