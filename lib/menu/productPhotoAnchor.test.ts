import { describe, expect, it } from "vitest";
import { existingProductPhotoAnchor } from "./productPhotoAnchor";

describe("existingProductPhotoAnchor", () => {
  it("keeps an Americano photo on sibling A after an earlier UUID is added", () => {
    const siblingA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    expect(existingProductPhotoAnchor([siblingA], [siblingA])).toBe(siblingA);
    expect(existingProductPhotoAnchor([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      siblingA,
    ], [siblingA])).toBe(siblingA);
  });
});
