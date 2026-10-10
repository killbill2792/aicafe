import {describe,it,expect} from "vitest";
import {compareSupplierQuotePrices} from "./supplierQuotes";
describe("supplier quote comparisons",()=>{
 it("compares exact matching packages in integer cents",()=>{
  expect(compareSupplierQuotePrices(
   {priceCents:1350,packageCount:1,packageUnit:"gal"},
   {priceCents:1250,packageCount:1,packageUnit:"gal"}))
   .toEqual({comparable:true,differenceCents:-100});
 });
 it("refuses mismatched units or package counts",()=>{
  expect(compareSupplierQuotePrices(
   {priceCents:1350,packageCount:1,packageUnit:"gal"},
   {priceCents:350,packageCount:1,packageUnit:"liter"})).toMatchObject({comparable:false});
  expect(compareSupplierQuotePrices(
   {priceCents:1350,packageCount:1,packageUnit:"case"},
   {priceCents:2600,packageCount:2,packageUnit:"case"})).toMatchObject({comparable:false});
 });
});
