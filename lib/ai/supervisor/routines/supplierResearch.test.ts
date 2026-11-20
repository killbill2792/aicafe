import {describe,it,expect} from "vitest";
import {publicSupplierLeadQuery} from "./supplierResearch";
describe("source-bound public supplier research",()=>{
 it("uses only a fixed product vocabulary and saved public city",()=>{
  expect(publicSupplierLeadQuery(" Whole Milk ","Los Angeles")).toBe("Wholesale whole milk suppliers serving Los Angeles. Public supplier website leads only; no confirmed quote, price, inventory or delivery.");
 });
 it("rejects arbitrary ingredient text, malicious city and missing geography",()=>{
  expect(publicSupplierLeadQuery("Milk invoice secret","Los Angeles")).toBeNull();
  expect(publicSupplierLeadQuery("milk","123 Main St")).toBeNull();
  expect(publicSupplierLeadQuery("milk","private customer")).toBeNull();
  expect(publicSupplierLeadQuery("milk",null)).toBeNull();
  expect(publicSupplierLeadQuery("__proto__","Los Angeles")).toBeNull();
 });
});
