import { describe, expect, it } from "vitest";
import { HOT_SIZES, ICED_SIZES, RECIPE_TEMPLATES, recipeSizesFor, scaledTemplateLines, shotsForSize, templateRecipeForSize } from "./recipeTemplates";
import { PANTRY_STARTERS, PANTRY_STARTERS_BY_KEY } from "./pantryStarter";

describe("pantry starter catalog", () => {
  it("never invents a price and always supplies a legal base unit and pack", () => {
    const keys = new Set<string>();
    for (const item of PANTRY_STARTERS) {
      expect(item).not.toHaveProperty("priceCents");
      expect(item).not.toHaveProperty("costPerBaseMicros");
      expect(["g", "ml", "each"]).toContain(item.baseUnit);
      expect(item.packQuantity).toBeGreaterThan(0);
      expect(keys.has(item.key)).toBe(false);
      keys.add(item.key);
    }
    expect(PANTRY_STARTERS_BY_KEY.get("milk-whole")).toMatchObject({packUnit:"gal",packQuantity:1});
    expect(PANTRY_STARTERS_BY_KEY.get("espresso-beans")).toMatchObject({packUnit:"lb",packQuantity:5,baseUnitsPerOperationalUnit:18});
    expect(PANTRY_STARTERS_BY_KEY.get("syrup-vanilla")?.baseUnitsPerOperationalUnit).toBe(7.5);
    expect(PANTRY_STARTERS_BY_KEY.get("sauce-mocha")?.baseUnitsPerOperationalUnit).toBe(15);
  });
});
describe("all-size café recipes", () => {
  it("provides every template with all expected sizes and existing pantry ingredients", () => {
    expect(RECIPE_TEMPLATES).toHaveLength(13);
    for (const template of RECIPE_TEMPLATES) {
      const sizes = recipeSizesFor(template.key);
      expect(sizes).toEqual(template.iced ? ICED_SIZES : HOT_SIZES);
      for (const size of sizes) {
        const recipe = templateRecipeForSize(template.key, size)!;
        const ids = recipe.map((line) => line.starterKey);
        expect(ids).toContain(`cup-${template.iced ? "cold" : "hot"}-${size}`);
        expect(ids).toContain(template.iced ? "lid-cold" : "lid-hot");
        expect(ids).toContain(template.iced ? "straw" : "sleeve");
        expect(new Set(ids).size).toBe(ids.length);
        for (const item of recipe) {
          expect(PANTRY_STARTERS_BY_KEY.has(item.starterKey)).toBe(true);
          expect(item.displayQuantity).toBeGreaterThan(0);
          if (item.displayUnit === "fl_oz") expect(item.displayQuantity * 2).toBe(Math.round(item.displayQuantity * 2));
        }
      }
    }
  });
  it("uses size-specific espresso shots and swaps packaging on scaling", () => {
    expect([8,12,16,20,24].map(shotsForSize)).toEqual([1,2,2,3,3]);
    const latte12 = templateRecipeForSize("latte", 12)!;
    const latte20 = templateRecipeForSize("latte", 20)!;
    expect(latte12.find((line) => line.starterKey === "espresso-beans")?.displayQuantity).toBe(2);
    expect(latte20.find((line) => line.starterKey === "espresso-beans")?.displayQuantity).toBe(3);
    const cloned = scaledTemplateLines(latte12,12,20,false);
    expect(cloned.find((line) => line.starterKey.startsWith("cup-"))?.starterKey).toBe("cup-hot-20");
    expect(cloned.find((line) => line.starterKey === "espresso-beans")?.displayQuantity).toBe(3);
    expect(templateRecipeForSize("iced-latte",12)).toBeNull();
    const iced16 = templateRecipeForSize("iced-latte", 16)!;
    const iced20 = scaledTemplateLines(iced16, 16, 20, true);
    expect(iced20.find((line) => line.starterKey.startsWith("cup-"))?.starterKey).toBe("cup-cold-20");
    expect(iced20).toContainEqual({ starterKey: "lid-cold", displayUnit: "each", displayQuantity: 1 });
    expect(iced20).toContainEqual({ starterKey: "straw", displayUnit: "each", displayQuantity: 1 });
  });
});
