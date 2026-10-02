import { describe, expect, it } from "vitest";
import { priceReviewDirection, priceReviewHref } from "./priceReviewTask";

describe("price review presentation", () => {
  it("uses low copy for an increase and high copy for a decrease", () => {
    expect(priceReviewDirection(500, 550)).toBe("low");
    expect(priceReviewDirection(600, 550)).toBe("high");
  });
  it("deep-links to the exact size's Overview price editor", () => {
    expect(priceReviewHref("size-id")).toBe("/menu/size-id?tab=overview&editPrice=size-id");
  });
});
