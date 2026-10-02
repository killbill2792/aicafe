import { describe, expect, it } from "vitest";
import { MENU_ITEM_CATEGORY_CODES } from "@/lib/constants";
import { categoryToOwnerItemType, OWNER_ITEM_TYPE_TO_CATEGORY, OWNER_ITEM_TYPES } from "./itemType";

describe("item type mapping", () => {
  it("maps every non-automatic owner type onto a real internal category", () => {
    for (const type of OWNER_ITEM_TYPES) {
      if (type === "AUTOMATIC") continue;
      expect(MENU_ITEM_CATEGORY_CODES).toContain(OWNER_ITEM_TYPE_TO_CATEGORY[type]);
    }
  });

  it("covers every internal category code exactly once", () => {
    const covered = Object.values(OWNER_ITEM_TYPE_TO_CATEGORY);
    expect(new Set(covered).size).toBe(MENU_ITEM_CATEGORY_CODES.length);
    for (const code of MENU_ITEM_CATEGORY_CODES) expect(covered).toContain(code);
  });

  it("round-trips: mapping a category to a type and back gives the same category", () => {
    for (const category of MENU_ITEM_CATEGORY_CODES) {
      const type = categoryToOwnerItemType(category);
      expect(OWNER_ITEM_TYPE_TO_CATEGORY[type]).toBe(category);
    }
  });

  it("never resolves an existing category to AUTOMATIC", () => {
    for (const category of MENU_ITEM_CATEGORY_CODES) {
      expect(categoryToOwnerItemType(category)).not.toBe("AUTOMATIC");
    }
  });
});
