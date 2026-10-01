import { describe, expect, it } from "vitest";
import { matchCatalogItem } from "./catalogMatching";

const candidates = [{ id: "latte", name: "Latte 12 oz", sizeLabel: "12 oz", priceCents: 575, category: "ESPRESSO_DRINK", posItemId: null }];

describe("matchCatalogItem", () => {
  it("attaches an existing external identity without replacing the canonical id", () => {
    expect(matchCatalogItem({ posItemId: "sq-1", name: "Changed", priceCents: 600, category: null }, [{ ...candidates[0], posItemId: "sq-1" }]).candidateId).toBe("latte");
  });
  it("requires review for name-only matches", () => {
    expect(matchCatalogItem({ posItemId: "sq-2", name: "Latte 12 oz", priceCents: 600, category: null }, candidates).status).toBe("needs_review");
  });
  it("marks unmatched products as new", () => {
    expect(matchCatalogItem({ posItemId: "sq-3", name: "Mocha", priceCents: 650, category: null }, candidates).status).toBe("new");
  });
});
