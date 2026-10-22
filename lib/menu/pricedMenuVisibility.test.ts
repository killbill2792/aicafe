import { describe, expect, it } from "vitest";
import { visiblePricedMenuItems } from "./pricedMenuVisibility";

describe("legacy menu screens never invent a missing selling price", () => {
  it("hides unpriced inactive size drafts rather than displaying $0.00 or negative margin", () => {
    const priced = { id:"latte", price_cents:550, is_active:true };
    const draft = { id:"latte-20", price_cents:null, is_active:false };
    expect(visiblePricedMenuItems([priced,draft])).toEqual([priced]);
  });
  it("keeps genuine zero price as zero rather than confusing it with unknown", () => {
    const free = { id:"promo", price_cents:0 };
    expect(visiblePricedMenuItems([free])).toEqual([free]);
  });
  it("does not mutate the backing array of all database size records", () => {
    const items = [{id:"priced",price_cents:550},{id:"draft",price_cents:null}];
    visiblePricedMenuItems(items);
    expect(items).toHaveLength(2);
  });
});
