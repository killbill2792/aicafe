import {describe,it,expect} from "vitest";
import {medianObservedUnitPriceCents} from "./importedMenuPrice";
import {inferMenuItemCategory} from "@/lib/menu/inferCategory";
describe("CSV import price and category",()=>{
 it("uses a median rather than a misleading day-one modifier average",()=>{
  expect(medianObservedUnitPriceCents([
   {netSalesCents:2000,quantity:1},{netSalesCents:4500,quantity:10},{netSalesCents:5000,quantity:10},
  ])).toBe(500);
 });
 it("takes midpoint median for an even number of groups",()=>{
  expect(medianObservedUnitPriceCents([{netSalesCents:400,quantity:1},{netSalesCents:500,quantity:1}])).toBe(450);
 });
 it("does not manufacture a price from empty/invalid volume",()=>{
  expect(medianObservedUnitPriceCents([{netSalesCents:1000,quantity:0}])).toBeNull();
 });
 it("infers a pastry for a muffin and espresso for a latte",()=>{
  expect(inferMenuItemCategory("Blueberry Muffin")).toBe("PASTRY");
  expect(inferMenuItemCategory("Latte")).toBe("ESPRESSO_DRINK");
 });
});
