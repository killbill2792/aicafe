import { describe, expect, it } from "vitest";
import { itemIngredientCostCents, recommendedPriceCents } from "./ingredients";

describe("itemIngredientCostCents", () => {
  it("sums recipe lines at today's ingredient price and applies modifier deltas", () => {
    const prices = { espresso: 1_600_000, milk: 120_000 }; // micro-cents per g/ml
    const cost = itemIngredientCostCents(
      [
        { ingredientId: "espresso", quantity: 18 },
        { ingredientId: "milk", quantity: 295 },
      ],
      prices,
      [{ ingredientId: "milk", quantityDelta: 50 }], // e.g. "extra milk" modifier
    );
    // (18*1,600,000 + (295+50)*120,000) / 1,000,000
    expect(cost).toBeCloseTo((18 * 1_600_000 + 345 * 120_000) / 1_000_000, 6);
  });

  it("treats an unknown ingredient price as 0 rather than throwing", () => {
    expect(itemIngredientCostCents([{ ingredientId: "missing", quantity: 10 }], {})).toBe(0);
  });
});

describe("recommendedPriceCents", () => {
  it("targets 30% ingredient cost by default", () => {
    // $1.50 cost / 0.30 = exactly $5.00 — already a multiple of 25¢
    expect(recommendedPriceCents(150)).toBe(500);
  });

  it("rounds up to the next 25¢, never down below the target margin", () => {
    // $1.60 cost / 0.30 = $5.33... — must round up to $5.50, not down to $5.25
    expect(recommendedPriceCents(160)).toBe(550);
  });

  it("accepts a custom target ratio", () => {
    expect(recommendedPriceCents(100, 0.25)).toBe(400); // $1.00 / 0.25 = exactly $4.00
  });

  it("returns 0 for a zero or negative ingredient cost — nothing to base a suggestion on", () => {
    expect(recommendedPriceCents(0)).toBe(0);
    expect(recommendedPriceCents(-50)).toBe(0);
  });
});
