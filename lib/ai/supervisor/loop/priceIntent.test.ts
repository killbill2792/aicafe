import {describe,expect,it} from "vitest";
import {normalizedDrinkName,ownerQuotedPriceDelta,ownerNamedUniqueProduct} from "./priceIntent";
const catalog=[
 {id:"latte-small",name:"Latte 12 oz",baseName:"Latte"},
 {id:"latte-large",name:"Latte 16 oz",baseName:"Latte"},
 {id:"mocha",name:"Mocha",baseName:"Mocha"},
];
describe("registered semantic proposal source validation",()=>{
 it("validates owner-authored cents in direct and contextual EN/ES/AR requests",()=>{
  expect(ownerQuotedPriceDelta("Let's test a 10-cent increase on the latte","",10)).toBe(true);
  expect(ownerQuotedPriceDelta("Probemos subir el precio 15 centavos",undefined,15)).toBe(true);
  expect(ownerQuotedPriceDelta("لنجرب رفع السعر ١٠ سنتات",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Let's try it","Raise latte price by 10 cents",10)).toBe(true);
 });
 it("refuses invented, ambiguous, zero, negative and unquoted numeric inputs",()=>{
  expect(ownerQuotedPriceDelta("Try adding 10 cents or 20 cents",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Try adding 10 cents",undefined,15)).toBe(false);
  expect(ownerQuotedPriceDelta("Try it",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Try adding 0 cents",undefined,0)).toBe(false);
  expect(ownerQuotedPriceDelta("Try adding 2.5 cents",undefined,5)).toBe(false);
 });
 it("requires a unique named catalog variant, never model-selected ambiguity",()=>{
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Latte",undefined,"latte-small",catalog)).toBe(false);
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Latte 12 oz",undefined,"latte-small",catalog)).toBe(true);
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Mocha",undefined,"mocha",catalog)).toBe(true);
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Mocha",undefined,"latte-small",catalog)).toBe(false);
  expect(normalizedDrinkName("Latte · 12 OZ")).toBe("latte 12 oz");
 });
});
