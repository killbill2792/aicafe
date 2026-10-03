import { describe, expect, it } from "vitest";
import { prepareNewIngredientAdditions } from "./newIngredientRecipe";

describe("prepareNewIngredientAdditions", () => {
  it("puts a new ingredient's pump line first so its conversion is created once", () => {
    const ml = { size: "small", amount: { unit: "ml" as const } };
    const pump = { size: "large", amount: { unit: "pump" as const } };
    const result = prepareNewIngredientAdditions([ml, pump]);
    expect(result.operationalUnit).toBe("pump");
    expect(result.ordered).toEqual([pump, ml]);
  });

  it("puts a new ingredient's shot line first and leaves physical-only rows unchanged", () => {
    const grams = { size: "small", amount: { unit: "g" as const } };
    const shot = { size: "large", amount: { unit: "shot" as const } };
    expect(prepareNewIngredientAdditions([grams, shot])).toEqual({ operationalUnit: "shot", ordered: [shot, grams] });
    expect(prepareNewIngredientAdditions([grams])).toEqual({ operationalUnit: null, ordered: [grams] });
  });
});
