import { describe, expect, it } from "vitest";
import { calculatePantryPriceImpact } from "./pantryImpact";

describe("pantry price impact", () => {
  const items = [{ id: "latte", name: "Latte", priceCents: 550 }];
  const lines = [{ menuItemId: "latte", ingredientId: "milk", quantity: 100 },
    { menuItemId: "latte", ingredientId: "espresso", quantity: 18 }];
  it("changes all recipe and margin money in integer cents when fully priced", () => {
    const [row] = calculatePantryPriceImpact(items, lines, { milk: 200_000, espresso: 1_000_000 },
      "milk", 300_000);
    expect(row.beforeCostCents).toBe(38);
    expect(row.afterCostCents).toBe(48);
    expect(row.marginBeforeCents).toBe(512);
    expect(row.marginAfterCents).toBe(502);
    expect(row.marginChangeCents).toBe(-10);
  });
  it("does not invent costs where other recipe ingredients are unpriced", () => {
    const [row] = calculatePantryPriceImpact(items, lines, { milk: 200_000 }, "milk", 300_000);
    expect(row.beforeCostCents).toBeNull();
    expect(row.afterCostCents).toBeNull();
    expect(row.marginChangeCents).toBeNull();
  });
  it("preserves an owner's aggregate fallback while a recipe is incomplete", () => {
    const [row] = calculatePantryPriceImpact(items, lines, { milk: 200_000 },
      "milk", 300_000, { latte: 99 });
    expect(row.beforeCostCents).toBe(99);
    expect(row.afterCostCents).toBe(99);
    expect(row.marginChangeCents).toBe(0);
  });
  it("does not assign a margin to draft items without a selling price", () => {
    const [row] = calculatePantryPriceImpact([{ ...items[0], priceCents: null }],
      lines, { milk: 200_000, espresso: 1_000_000 }, "milk", 300_000);
    expect(row.beforeCostCents).toBe(38);
    expect(row.marginBeforeCents).toBeNull();
  });
});
