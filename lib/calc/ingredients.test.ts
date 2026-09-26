import { describe, expect, it } from "vitest";
import { itemIngredientCostCents } from "./ingredients";

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
