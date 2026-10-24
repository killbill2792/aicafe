import {describe,it,expect} from "vitest";
import {priceCheck,priceSource} from "./menuPriceCheck";
describe("money evidence contracts",()=>{
 it("flags the imported $20 latte when realized at $5",()=>{
  expect(priceCheck(2000,500)).toBe("differs");
  expect(priceSource("imported","csv")).toBe("imported_avg");
 });
 it("does not mistake a small change for a meaningful discrepancy",()=>{
  expect(priceCheck(510,500)).toBe("ok");
  expect(priceCheck(600,500)).toBe("ok");
  expect(priceCheck(900,null)).toBe("ok");
 });
 it("does not let catalog import provenance override an owner's manual price",()=>{
  expect(priceSource("owner_manual","csv")).toBe("owner_manual");
  expect(priceSource(null,"csv")).toBe("imported_avg");
 });
});
