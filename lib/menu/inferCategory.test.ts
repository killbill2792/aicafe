import { describe, expect, it } from "vitest";
import { inferMenuItemCategory } from "./inferCategory";

describe("inferMenuItemCategory", () => {
  it.each([
    ["Americano", "ESPRESSO_DRINK"],
    ["Latte", "ESPRESSO_DRINK"],
    ["Macchiato", "ESPRESSO_DRINK"],
    ["Cappuccino", "ESPRESSO_DRINK"],
    ["Espresso", "ESPRESSO_DRINK"],
    ["Mocha", "ESPRESSO_DRINK"],
    ["Iced Caramel Macchiato", "ESPRESSO_DRINK"],
    ["Cold Brew", "COLD_BREW"],
    ["Nitro Cold Brew", "COLD_BREW"],
    ["Drip Coffee", "BREWED_COFFEE"],
    ["Pour Over", "BREWED_COFFEE"],
    ["Green Tea", "TEA"],
    ["Blueberry Pastry", "PASTRY"],
    ["Croissant", "PASTRY"],
  ])("infers %s as %s", (name, expected) => {
    expect(inferMenuItemCategory(name)).toBe(expected);
  });

  it("prefers tea/chai/matcha over the generic 'latte' word — a tea latte is tea, not espresso", () => {
    expect(inferMenuItemCategory("Matcha Latte")).toBe("TEA");
    expect(inferMenuItemCategory("Chai Latte")).toBe("TEA");
    expect(inferMenuItemCategory("Iced Chai Latte")).toBe("TEA");
  });

  it("falls back to the menu group's default when the name itself gives no obvious hint", () => {
    expect(inferMenuItemCategory("House Blend", "Bakery")).toBe("PASTRY");
    expect(inferMenuItemCategory("House Blend", "Retail")).toBe("RETAIL");
  });

  it("falls back to espresso drink when neither the name nor the group gives a hint", () => {
    expect(inferMenuItemCategory("Mystery Item")).toBe("ESPRESSO_DRINK");
  });
});
