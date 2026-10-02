import { describe, expect, it } from "vitest";
import { identicalDifferentSizeRecipe } from "./identicalSiblingRecipe";

describe("identicalDifferentSizeRecipe", () => {
  it("calmly identifies a different size with identical unscaled quantities", () => {
    const recipe = [{ ingredientId: "milk", quantity: 300 }, { ingredientId: "coffee", quantity: 18 }];
    expect(identicalDifferentSizeRecipe({ id: "20", sizeLabel: "20 oz", recipe }, [{ id: "16", sizeLabel: "16 oz", recipe: [...recipe].reverse() }])).toBe("16 oz");
  });
  it("does not warn for different quantities", () => expect(identicalDifferentSizeRecipe({ id: "20", sizeLabel: "20 oz", recipe: [{ ingredientId: "milk", quantity: 300 }] }, [{ id: "16", sizeLabel: "16 oz", recipe: [{ ingredientId: "milk", quantity: 240 }] }])).toBeNull());
});
