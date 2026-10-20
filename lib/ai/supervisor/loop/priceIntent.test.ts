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
 it("rejects nonadjacent price alternatives regardless of filler language",()=>{
  expect(ownerQuotedPriceDelta("Try 10 or maybe 20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 10 or maybe 20 cents",undefined,10)).toBe(false);
  expect(ownerQuotedPriceDelta("Prueba 10 o quizás 20 centavos",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ١٠ أو ربما ٢٠ سنتات",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 10 or, if that's too much, 20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Let's try 10 versus perhaps 20¢",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 10 or maybe $0.20",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Let's try it","Prueba 10 o quizás 20 centavos",20)).toBe(false);
  // An explicitly size-typed drink is NOT a second proposed price amount.
  expect(ownerQuotedPriceDelta("Latte 12 oz, increase 10 cents",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Latte 12oz increase 10 cents",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Try 10 cents on a 16oz latte",undefined,10)).toBe(true);
  expect(ownerQuotedPriceDelta("Try a $0.10 increase on Latte 12 oz",undefined,10)).toBe(true);
 });
 it("treats spelled-out alternatives as ambiguous but typed percentage as context",()=>{
  expect(ownerQuotedPriceDelta("Try ten or maybe 20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Prueba diez o quizás 20 centavos",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب عشرة أو ربما ٢٠ سنتات",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try thirty or perhaps $0.20",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Sales rose 10%, so raise the latte by 20 cents",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("Sales rose 10.5%, so raise the latte 20 cents",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("Ventas subieron un 10 %, subamos el latte 20 centavos",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("ارتفعت المبيعات ١٠٪ فلنجرب زيادة ٢٠ سنتات",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("The 12 oz latte grew 10%, raise price 20 cents",undefined,20)).toBe(true);
 });
 it("only rejects spoken numeric alternatives on either side of the monetary quote",()=>{
  expect(ownerQuotedPriceDelta("Try 20 cents or maybe thirty",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Prueba 20 centavos o quizás treinta",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ٢٠ سنتات أو ربما ثلاثين",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try ten or maybe 20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Sales stayed flat or rose 10%, so raise the latte by 20 cents",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("Sales stayed flat or rose ten percent; raise latte by 20 cents",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("حاول رفع سعر اللاتيه بمقدار ٢٠ سنتات",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("One or two days ago sales rose; test a 20-cent latte increase",undefined,20)).toBe(true);
 });
 it("rejects compound Spanish and Arabic basic cardinal price alternatives",()=>{
  expect(ownerQuotedPriceDelta("Prueba 20 centavos o quizás veinticinco",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Prueba veintidós o quizás 20 centavos",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ٢٠ سنتات أو ربما خمسة",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ثلاثة أو ربما ٢٠ سنتات",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ٢٠ سنتات أو ربما سبعة",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("لنجرب ٢٠ سنتات أو ربما تسعة",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try a single, specific 20-cent increase",undefined,20)).toBe(true);
 });
 it("does not conflate cardinals describing sales with alternate price offers",()=>{
  expect(ownerQuotedPriceDelta("Vendimos veinticinco bebidas o más, así que sube el latte 20 centavos",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("Vendimos veinte cafés o más, sube el latte 20 centavos",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("Sold twenty drinks or more, raise latte 20 cents",undefined,20)).toBe(true);
  expect(ownerQuotedPriceDelta("Try twenty or maybe 20 cents",undefined,20)).toBe(false);
  expect(ownerQuotedPriceDelta("Try 20 cents or maybe thirty",undefined,20)).toBe(false);
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
