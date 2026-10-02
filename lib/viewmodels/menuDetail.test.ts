import { describe, expect, it } from "vitest";
import { menuItemHref, parseMenuDetailTab } from "./menuDetail";

describe("menu detail tab context", () => {
  it.each(["overview", "recipe", "pricing"] as const)("accepts the known %s tab", (tab) => {
    expect(parseMenuDetailTab(tab)).toBe(tab);
  });

  it("rejects unknown URL values to overview", () => {
    expect(parseMenuDetailTab("delete-everything")).toBe("overview");
    expect(parseMenuDetailTab(undefined)).toBe("overview");
  });

  it("keeps the selected tab when routing to a real sibling item id", () => {
    expect(menuItemHref("16 oz/item", "recipe")).toBe("/menu/16%20oz%2Fitem?tab=recipe");
  });
});
