import {describe,it,expect} from "vitest";
import {calculateNewItemPrice} from "./newItemPrice";
const fixture=()=>({ingredientCostCents:140,packagingCents:20,targetMarginPercent:null,
 labor30dCents:90000,monthlyBillsCents:60000,units30d:1000,menuPricesCents:[400,500,600]});
describe("new unsaved item pricing",()=>{
 it("computes per-item expenses and quarter-dollar rounding",()=>{
  const r=calculateNewItemPrice(fixture());
  expect(r).toMatchObject({ingredientCostCents:140,packagingCents:20,laborPerItemCents:90,overheadPerItemCents:60,
   fullCostCents:310,costPlusPriceCents:365,ingredientBenchmarkCents:467,suggestedPriceCents:475,
   profitPerItemCents:165,ownMenuRange:{min:400,median:500,max:600,count:3}});
 });
 it("missing sales gives unknown costs and price, not a zero cost",()=>{
  const r=calculateNewItemPrice({...fixture(),units30d:null});
  expect(r.missing).toContain("itemSales30d");expect(r.laborPerItemCents).toBeNull();
  expect(r.fullCostCents).toBeNull();expect(r.suggestedPriceCents).toBeGreaterThan(0);expect(r.result.tier).toBe("floor_only");
 });
 it("respects owner margin and labels packaging assumption",()=>{
  const r=calculateNewItemPrice({...fixture(),targetMarginPercent:60,packagingCents:null});
  expect(r.costPlusPriceCents).toBe(725);expect(r.suggestedPriceCents).toBe(725);
  expect(r.estimated).toContain("packagingAssumedZero");
 });
});
