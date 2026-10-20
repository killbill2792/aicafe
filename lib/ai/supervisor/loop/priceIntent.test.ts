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
 it("refuses negative cent quotes masquerading as a requested increase",()=>{
  expect(ownerQuotedPriceDelta("Let's test -10 cents on latte",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Let's test −10 cents on latte",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Vamos a probar -10 centavos",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب −١٠ سنتات",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Let's test +10 cents on latte",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Let's test a 10-cent increase on latte",undefined,10)).toBe(true);
 });
 it("accepts exact USD decimals and cent symbols without rounding or losing sign",()=>{
  expect(ownerQuotedPriceDelta("Test the latte with a $0.10 increase",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Try a 10¢ increase",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Try a +10 ¢ increase",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Try a $1 increase",undefined,100)).toBe(true);
  expect(ownerQuotedPriceDelta("Try -$0.10",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Try −10¢",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Try $0.105",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Try $0.10 or $0.20",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Try a $0.20 increase",undefined,10)).toBe(false);
 });
 it("rejects alternatives that share a single cents unit instead of trusting the final value",()=>{
  expect(ownerQuotedPriceDelta("Try 10 or 20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 10–20¢",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 10/20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 10 cents or 20",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Prueba 10 o 20 centavos",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ١٠ أو ٢٠ سنتات",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Let's try it","Try 10 or 20 cents",20)).toBe(false);
  expect(ownerQuotedPriceDelta("Latte 12 oz, increase 10 cents",undefined,10)).toBe(true);
 });
 it("prefers this turn's explicit menu product over unrelated previous turns",()=>{
  expect(ownerNamedUniqueProduct("Let's test Latte 12 oz by 10 cents",
    "How is the Mocha selling?","latte-small",catalog)).toBe(true);
  expect(ownerNamedUniqueProduct("Let's test Latte 12 oz by 10 cents",
    "How is the Mocha selling?","mocha",catalog)).toBe(false);
  expect(ownerNamedUniqueProduct("Let's try it",
    "Try Latte 12 oz by 10 cents","latte-small",catalog)).toBe(true);
  expect(ownerNamedUniqueProduct("Let's test Latte by 10 cents",
    "What about Mocha?","latte-small",catalog)).toBe(false);
 });
 it("requires a unique named catalog variant, never model-selected ambiguity",()=>{
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Latte",undefined,"latte-small",catalog)).toBe(false);
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Latte 12 oz",undefined,"latte-small",catalog)).toBe(true);
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Mocha",undefined,"mocha",catalog)).toBe(true);
  expect(ownerNamedUniqueProduct("Try a 10-cent increase for Mocha",undefined,"latte-small",catalog)).toBe(false);
  expect(ownerNamedUniqueProduct("Test a 10-cent increase on latte",undefined,"latte-small",[
    {id:"latte-small",name:"Iced Latte",baseName:"Iced Latte"},
    {id:"mocha",name:"Mocha",baseName:"Mocha"},
  ])).toBe(true);
  expect(normalizedDrinkName("Latte · 12 OZ")).toBe("latte 12 oz");
 });
});
