import { describe, expect, it } from "vitest";
import { evaluateRecipeCost } from "./ingredients";

describe("evaluateRecipeCost", () => {
  it("distinguishes no recipe from a zero cost", () => {
    expect(evaluateRecipeCost([], {})).toEqual({ status: "NO_RECIPE", costCents: null, missingIngredientIds: [] });
  });

  it("returns the missing ingredient ids instead of partial economics", () => {
    expect(evaluateRecipeCost([
      { ingredientId: "coffee", quantity: 18 },
      { ingredientId: "milk", quantity: 200 },
    ], { coffee: 40_000 })).toEqual({
      status: "MISSING_INGREDIENT_COST",
      costCents: null,
      missingIngredientIds: ["milk"],
    });
  });

  it("costs a complete recipe", () => {
    expect(evaluateRecipeCost([{ ingredientId: "milk", quantity: 200 }], { milk: 12_500 })).toEqual({
      status: "READY",
      costCents: 2.5,
      missingIngredientIds: [],
    });
  });
});
