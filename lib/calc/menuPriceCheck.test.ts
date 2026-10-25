import {describe,it,expect} from "vitest";
import {priceCheck,priceSource,realizedUnitAverage} from "./menuPriceCheck";
describe("money evidence contracts",()=>{
 it("flags an imported twenty-dollar latte when realized sales average five dollars",()=>{
  expect(priceCheck(2000,500)).toBe("differs");
  expect(priceSource("imported","csv")).toBe("imported_avg");
 });
 it("computes the quantity-weighted realized average",()=>{
  expect(realizedUnitAverage([{net_sales_cents:1000,quantity:2},{net_sales_cents:2400,quantity:6}])).toBe(425);
  expect(realizedUnitAverage([])).toBeNull();
 });
 it("does not mistake small deviations for material price discrepancies",()=>{
  expect(priceCheck(510,500)).toBe("ok");
  expect(priceCheck(600,500)).toBe("ok");
  expect(priceCheck(900,null)).toBe("ok");
 });
 it("does not let catalog provenance override a manual price",()=>{
  expect(priceSource("owner_manual","csv")).toBe("owner_manual");
  expect(priceSource(null,"csv")).toBe("imported_avg");
  expect(priceSource("initial","csv")).toBe("imported_avg");
 });
});
