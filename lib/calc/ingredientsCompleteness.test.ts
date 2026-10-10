import { describe, expect, it } from "vitest";
import { evaluateRecipeCost, resolveProductCost } from "./ingredients";

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


describe("resolveProductCost", () => {
  it("uses an owner total when there is no detailed recipe", () => {
    expect(resolveProductCost(evaluateRecipeCost([], {}), 145)).toMatchObject({
      status: "READY", costCents: 145, source: "owner_total", recipeStatus: "NO_RECIPE",
    });
  });

  it("uses an owner total when the detailed recipe is incomplete", () => {
    const recipe = evaluateRecipeCost(
      [{ ingredientId: "coffee", quantity: 18 }, { ingredientId: "milk", quantity: 200 }],
      { coffee: 40_000 },
    );
    expect(resolveProductCost(recipe, 175)).toMatchObject({
      status: "READY", costCents: 175, source: "owner_total", recipeStatus: "MISSING_INGREDIENT_COST",
    });
  });

  it("lets a complete recipe outrank the owner total without double counting", () => {
    const recipe = evaluateRecipeCost([{ ingredientId: "milk", quantity: 200 }], { milk: 1_000_000 });
    const resolved = resolveProductCost(recipe, 175);
    expect(resolved.costCents).toBe(200);
    expect(resolved.source).toBe("recipe");
    expect(resolved.ownerTotalCostCents).toBe(175);
    expect(resolved.differenceCents).toBe(25);
  });

  it("preserves a lower recipe-vs-owner difference", () => {
    const recipe = evaluateRecipeCost([{ ingredientId: "milk", quantity: 100 }], { milk: 1_000_000 });
    expect(resolveProductCost(recipe, 125).differenceCents).toBe(-25);
  });

  it("stays unavailable when neither source provides a product cost", () => {
    expect(resolveProductCost(evaluateRecipeCost([], {}), null)).toMatchObject({
      status: "NO_RECIPE", costCents: null, source: null,
    });
  });
});
