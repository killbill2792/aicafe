import {describe,it,expect} from "vitest";
import {hasInventoryReviewLink,reviewInventoryHref,selectRequestedPurchases} from "./inventoryReviewLinks";
describe("inventory review navigation",()=>{
 it("shows separate-page action only when at least two purchases exist",()=>{
  expect(hasInventoryReviewLink(1)).toBe(false);
  expect(hasInventoryReviewLink(2)).toBe(true);
  expect(reviewInventoryHref(["a","b"])).toBe("/menu/pantry?proposals=a%2Cb");
 });
 it("returns requested cards in link order, never unscoped IDs",()=>{
  const own=[{id:"b",threadId:"owner-thread"},{id:"a",threadId:"owner-thread"}];
  expect(selectRequestedPurchases(["a","other-tenant","b"],own)).toEqual([own[1],own[0]]);
 });
});
