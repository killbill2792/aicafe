import { describe, expect, it } from "vitest";
import { addCostChoiceSuffix, validCostCategory, validReturnTo } from "./routeParams";

describe("safe Add cost navigation", () => {
  it("accepts same-origin paths, including query strings", () => {
    expect(validReturnTo("/money")).toBe("/money");
    expect(validReturnTo(["/money"])).toBeNull();
    expect(validReturnTo(null)).toBeNull();
    expect(validReturnTo("/more/bills?category=rent")).toBe("/more/bills?category=rent");
    expect(validReturnTo("/money?filter=last%20month")).toBe("/money?filter=last%20month");
    expect(validReturnTo("/ar/money#expenses")).toBe("/ar/money#expenses");
  });
  it.each(["https://example.org", "javascript:alert(1)", "//example.org", "/\\example.org", "/%2fexample.org", "/%5cexample.org", "/%0dexample.org", "/money\nnext", "/bad%ZZ", "money"])("rejects unsafe destination %s", (value) => {
    expect(validReturnTo(value)).toBeNull();
  });
  it("preselects only recognized categories and keeps the return path encoded", () => {
    expect(validCostCategory("rent")).toBe("rent");
    expect(validCostCategory(["rent"])).toBeNull();
    expect(validCostCategory("bad")).toBeNull();
    expect(addCostChoiceSuffix("rent", "/more/bills?category=rent")).toBe("?category=rent&returnTo=%2Fmore%2Fbills%3Fcategory%3Drent");
    expect(addCostChoiceSuffix("bad", "//evil.invalid")).toBe("");
  });
});
