import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import ar from "../../messages/ar.json";
import { describe, expect, it } from "vitest";
import { recipeDisplayUnitsFor, needsIngredientConversion, toBaseUnitQuantity, packBaseQuantity, packToCostPerBaseMicros, plainQuantity, stepFor } from "./recipeUnits";

const messageCatalog = { en, es, ar };
function formatter(locale: "en" | "es" | "ar") {
  const translate = createTranslator({ locale, messages: messageCatalog[locale] });
  return (unit: string, values: { quantity: string; count: number }) =>
    translate(`Pantry.quantity.${unit}` as never, values as never);
}

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


describe("pack unit conversion and pack pricing", () => {
  it("converts US volume packs (and disambiguates oz as fluid for milk)", () => {
    expect(packBaseQuantity(1, "gal", "ml")).toBeCloseTo(3785.411784, 6);
    expect(packBaseQuantity(1, "qt", "ml")).toBeCloseTo(946.352946, 6);
    expect(packBaseQuantity(32, "oz", "ml")).toBeCloseTo(946.352946, 5);
    expect(packToCostPerBaseMicros(1, "gal", 1899, "ml")).toBe(
      Math.round(1899 * 1_000_000 / 3785.411784));
  });
  it("converts weights and the industry-standard case(n) packs", () => {
    expect(packBaseQuantity(5, "lb", "g")).toBeCloseTo(2267.96185);
    expect(packBaseQuantity(1, "oz", "g")).toBeCloseTo(28.349523125);
    expect(packBaseQuantity(1, "case(1000)", "each")).toBe(1000);
    expect(packToCostPerBaseMicros(1, "case(1000)", 5000, "each")).toBe(5_000_000);
  });
  it("blocks mismatched physical dimensions and malformed or unsafe packs", () => {
    expect(packBaseQuantity(1, "lb", "ml")).toBeNull();
    expect(packBaseQuantity(1, "oz", "each")).toBeNull();
    expect(packBaseQuantity(1, "case(0)", "each")).toBeNull();
    expect(packBaseQuantity(1, "case(999999999999999999)", "each")).toBeNull();
    expect(packToCostPerBaseMicros(1, "gal", -5, "ml")).toBeNull();
    expect(packToCostPerBaseMicros(0, "gal", 100, "ml")).toBeNull();
  });
  it("uses owner-friendly step sizes and fractions with no decimals", () => {
    expect(stepFor("shot")).toBe(1);
    expect(stepFor("pump")).toBe(1);
    expect(stepFor("fl_oz")).toBe(0.5);
    expect(stepFor("oz_wt")).toBe(0.5);
    expect(plainQuantity(2, "shot", "en", formatter("en"))).toBe("2 shots");
    expect(plainQuantity(0.5, "fl_oz", "en", formatter("en"))).toBe("½ oz");
    expect(plainQuantity(0.25, "fl_oz", "en", formatter("en"))).toBe("¼ oz");
    expect(plainQuantity(0.75, "fl_oz", "en", formatter("en"))).toBe("¾ oz");
    expect(plainQuantity(1, "cup", "en", formatter("en"), 12)).toBe("1 cup (12 oz)");
    expect(plainQuantity(2, "cup", "es", formatter("es"))).toBe("2 tazas");
    expect(plainQuantity(1, "cup", "ar", formatter("ar"))).toContain("كوب");
    expect(plainQuantity(2, "shot", "ar", formatter("ar"))).toContain("جرعتان");
  });
});
