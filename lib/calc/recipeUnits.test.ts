import { describe, expect, it } from "vitest";
import { recipeDisplayUnitsFor, needsIngredientConversion, toBaseUnitQuantity } from "./recipeUnits";

describe("recipeDisplayUnitsFor", () => {
  it("lets a brand-new volume ingredient use ml, fl oz, or an exact pump conversion", () => {
    expect(recipeDisplayUnitsFor("ml")).toEqual(["ml", "fl_oz", "pump"]);
  });
  it("lets a brand-new weight ingredient use g or an exact shot conversion", () => {
    expect(recipeDisplayUnitsFor("g")).toEqual(["g", "shot"]);
  });
  it("keeps a brand-new count ingredient canonical in each", () => {
    expect(recipeDisplayUnitsFor("each")).toEqual(["each"]);
  });
  it("offers only the operational conversions stored for that exact ingredient", () => {
    expect(recipeDisplayUnitsFor("ml", [{ unit: "pump", baseUnitsPerUnit: 7.5 }])).toEqual(["ml", "fl_oz", "pump"]);
    expect(recipeDisplayUnitsFor("ml", [{ unit: "shot", baseUnitsPerUnit: 30 }])).toEqual(["ml", "fl_oz", "pump", "shot"]);
    expect(recipeDisplayUnitsFor("g", [{ unit: "shot", baseUnitsPerUnit: 18 }])).toEqual(["g", "shot"]);
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

  it("converts a new ingredient only after its exact inline conversion is supplied", () => {
    expect(toBaseUnitQuantity("pump", 3, "ml")).toBeNull();
    expect(toBaseUnitQuantity("pump", 3, "ml", [{ unit: "pump", baseUnitsPerUnit: 8.5 }])).toBe(25.5);
    expect(toBaseUnitQuantity("shot", 2, "g")).toBeNull();
    expect(toBaseUnitQuantity("shot", 2, "g", [{ unit: "shot", baseUnitsPerUnit: 19 }])).toBe(38);
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

  it("rejects every physical unit that doesn't match the ingredient's base unit", () => {
    // g only valid with a gram-based ingredient
    expect(toBaseUnitQuantity("g", 10, "ml")).toBeNull();
    expect(toBaseUnitQuantity("g", 10, "each")).toBeNull();
    // ml only valid with a ml-based ingredient
    expect(toBaseUnitQuantity("ml", 10, "g")).toBeNull();
    expect(toBaseUnitQuantity("ml", 10, "each")).toBeNull();
    // fl oz only valid with a ml-based ingredient (it's a physical ml conversion)
    expect(toBaseUnitQuantity("fl_oz", 10, "g")).toBeNull();
    expect(toBaseUnitQuantity("fl_oz", 10, "each")).toBeNull();
    // each only valid with a count-based ingredient
    expect(toBaseUnitQuantity("each", 1, "g")).toBeNull();
    expect(toBaseUnitQuantity("each", 1, "ml")).toBeNull();
  });
});
