import { describe, expect, it } from "vitest";
import { recipeDisplayUnitsFor, needsIngredientConversion, toBaseUnitQuantity } from "./recipeUnits";

describe("recipeDisplayUnitsFor", () => {
  it("offers ml, fl oz, shot, and pump for a ml-based ingredient", () => {
    expect(recipeDisplayUnitsFor("ml")).toEqual(["ml", "fl_oz", "shot", "pump"]);
  });
  it("offers g, shot, and pump for a gram-based ingredient", () => {
    expect(recipeDisplayUnitsFor("g")).toEqual(["g", "shot", "pump"]);
  });
  it("offers only each for a count-based ingredient", () => {
    expect(recipeDisplayUnitsFor("each")).toEqual(["each"]);
  });
});

describe("needsIngredientConversion", () => {
  it("is true only for shot/pump", () => {
    expect(needsIngredientConversion("shot")).toBe(true);
    expect(needsIngredientConversion("pump")).toBe(true);
    expect(needsIngredientConversion("ml")).toBe(false);
    expect(needsIngredientConversion("fl_oz")).toBe(false);
    expect(needsIngredientConversion("g")).toBe(false);
    expect(needsIngredientConversion("each")).toBe(false);
  });
});

describe("toBaseUnitQuantity", () => {
  it("passes through a unit that already matches the base unit", () => {
    expect(toBaseUnitQuantity("ml", 8, "ml")).toBe(8);
    expect(toBaseUnitQuantity("g", 15, "g")).toBe(15);
    expect(toBaseUnitQuantity("each", 1, "each")).toBe(1);
  });

  it("converts fl oz to ml using the fixed physical constant", () => {
    expect(toBaseUnitQuantity("fl_oz", 8, "ml")).toBeCloseTo(236.588, 2);
  });

  it("returns null for a shot/pump with no stored conversion for that ingredient", () => {
    expect(toBaseUnitQuantity("shot", 2, "g", [])).toBeNull();
    expect(toBaseUnitQuantity("pump", 2, "ml", [])).toBeNull();
  });

  it("uses the ingredient-specific conversion once one is stored", () => {
    expect(toBaseUnitQuantity("shot", 2, "g", [{ unit: "shot", baseUnitsPerUnit: 18 }])).toBe(36);
    expect(toBaseUnitQuantity("pump", 2, "ml", [{ unit: "pump", baseUnitsPerUnit: 7.5 }])).toBe(15);
  });

  it("never applies one ingredient's shot/pump conversion to a different unit", () => {
    expect(toBaseUnitQuantity("pump", 2, "ml", [{ unit: "shot", baseUnitsPerUnit: 30 }])).toBeNull();
  });

  it("guards against zero or negative quantities", () => {
    expect(toBaseUnitQuantity("ml", 0, "ml")).toBeNull();
    expect(toBaseUnitQuantity("ml", -5, "ml")).toBeNull();
  });
});
