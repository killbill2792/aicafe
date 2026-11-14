import {describe,expect,it} from "vitest";
import {authorizesInventoryWrite,ownerTextSupportsTypedLine,ownerTextSupportsTypedFinancials,receivedPurchaseDocument,isPurchaseCorrection} from "./purchaseIntent";
describe("explicit owner-turn purchase authority",()=>{
 it("supports the common short owner instruction",()=>{
  expect(authorizesInventoryWrite("I bought 10 gallons of milk",false)).toBe(true);
 });
 it("grounds typed quantities and units in the owner message before writing",()=>{
  const line={name:"milk",quantity:10,unit:"gal"};
  expect(ownerTextSupportsTypedLine("I bought 10 gallons of milk today",line)).toBe(true);
  expect(ownerTextSupportsTypedLine("I bought 10 gallons of milk",line)).toBe(true);
  expect(ownerTextSupportsTypedLine("I bought 2 gallons of milk",line)).toBe(false);
  expect(ownerTextSupportsTypedLine("Please update inventory",line)).toBe(false);
  expect(ownerTextSupportsTypedLine("I bought 10 gallons of cream",line)).toBe(false);
  expect(ownerTextSupportsTypedLine("I bought 10 gallons of milk and 2 pounds of beans",{name:"beans",quantity:10,unit:"gal"})).toBe(false);
  expect(ownerTextSupportsTypedLine("I bought 10 gallons of milk and 2 pounds of beans",{name:"beans",quantity:2,unit:"lb"})).toBe(true);
  expect(ownerTextSupportsTypedLine("I bought 10 gallons of whole milk",{name:"milk",quantity:10,unit:"gal"})).toBe(true);
 });

 it("blocks invented or altered cost and backdated typed inventory effects",()=>{
  const today="2026-11-13";
  const check=(message:string,costCents:number|null,date="2026-11-13",lineCount=1,currency="USD")=>
   ownerTextSupportsTypedFinancials(message,{costCents,date},today,lineCount,currency);
  // Owner gave quantity, not money: never use a model-invented ingredient price.
  expect(check("I bought 10 gallons of milk",null)).toBe(true);
  expect(check("I bought 10 gallons of milk",4500)).toBe(false);
  expect(check("I bought 10 gallons of milk","4500" as unknown as number)).toBe(false);
  expect(check("I bought 10 gallons of milk",null,"2026-11-12")).toBe(false);
  expect(check("I bought 10 gallons of milk yesterday",null,"2026-11-12")).toBe(true);
  expect(check("I bought 10 gallons of milk yesterday",null,"2026-11-13")).toBe(false);
  expect(check("I bought 10 gallons of milk on 2026-11-10",null,"2026-11-10")).toBe(true);
  expect(check("I bought 10 gallons of milk on 2026-11-10",null,"2026-11-13")).toBe(false);
  expect(check("I bought 10 gallons of milk last Tuesday",null)).toBe(false);
  // Exact single owner money amount can be saved; changed cents, ambiguous
  // multi-line allocation or non-USD symbols require review instead.
  expect(check("I bought 10 gallons of milk for $45.00",4500)).toBe(true);
  expect(check("I bought 10 gallons of milk for $45.00",450)).toBe(false);
  expect(check("I bought 10 gallons of milk for $45.00",null)).toBe(false);
  expect(check("I bought 10 gallons of milk for $45.00",4500,today,2)).toBe(false);
  expect(check("I bought 10 gallons of milk for $45.00",4500,today,1,"CAD")).toBe(false);
  expect(check("I bought 10 gallons of milk for CA$45.00",4500,today,1,"CAD")).toBe(true);
  expect(check("I bought 10 gallons of milk for €45.00",4500,today,1,"EUR")).toBe(true);
  expect(check("I bought 10 gallons of milk for $45 each",4500)).toBe(false);
  expect(check("I bought 10 gallons of milk and 2 lb beans for $45",4500,today,2)).toBe(false);
  // The model can split one owner utterance into two ONE-line tool calls.
  // A shared total must not be applied to either line regardless of batching.
  expect(check("I bought 10 gallons of milk and 2 lb beans for $45 total",4500,today,1)).toBe(false);
  expect(check("I bought 10 gallons of milk and 2 lb beans for $45 total",4500,today,2)).toBe(false);
  // Never parse a prefix of a grouped amount ($1,000) as $1.
  expect(check("I bought 10 gallons of milk for $1,000",100)).toBe(false);
  expect(check("I bought 10 gallons of milk for $1,000",100000)).toBe(false);
  expect(check("I bought 10 gallons of milk for $1,000.00",100)).toBe(false);
  expect(check("I bought 10 gallons of milk for $1,000.00",100000)).toBe(false);
  expect(check("I bought 10 gallons of milk for $45.00",4500)).toBe(true);

  expect(check("I bought 10 gallons of milk, paid 45",null)).toBe(false);
 });
 it("accepts clear owner instructions, no repeat click",()=>{
  expect(authorizesInventoryWrite("I bought 10 gallons of milk today",false)).toBe(true);
  expect(authorizesInventoryWrite("Please add these purchases to inventory.",true)).toBe(true);
  expect(authorizesInventoryWrite("Record this receipt as stock purchases",true)).toBe(true);
 });
 it("requires actual inventory authority instead of unrelated receipt edits",()=>{
  expect(authorizesInventoryWrite("Please update the receipt",true)).toBe(false);
  expect(authorizesInventoryWrite("Please record this invoice",true)).toBe(false);
  expect(authorizesInventoryWrite("Please record these purchases",true)).toBe(true);
  expect(authorizesInventoryWrite("Put these items into inventory",true)).toBe(true);
  expect(authorizesInventoryWrite("Actually I bought 8 gallons of milk",false)).toBe(false);
  expect(isPurchaseCorrection("Actually it was 8 gallons, not 10")).toBe(true);
 });
 it("accepts received purchase orders but never assumes pending delivery is stock",()=>{
  expect(receivedPurchaseDocument("receipt","Please add to inventory")).toBe(true);
  expect(receivedPurchaseDocument("purchase_order","I received these goods, add to inventory")).toBe(true);
  expect(receivedPurchaseDocument("purchase_order","This is my order, update inventory")).toBe(false);
  expect(receivedPurchaseDocument("invoice","Not received yet, update inventory")).toBe(false);
  expect(receivedPurchaseDocument("invoice","The goods were delivered, add to inventory")).toBe(true);
  expect(receivedPurchaseDocument("invoice","I received the invoice for 10 gallons of milk; add to inventory")).toBe(false);
  expect(receivedPurchaseDocument("purchase_order","I received my purchase order for the goods; update inventory")).toBe(false);
  expect(receivedPurchaseDocument("purchase_order","The supplies arrived, add them to inventory")).toBe(true);
 });
 it("never treats bare upload, uncertain language, or negation as authority",()=>{
  expect(authorizesInventoryWrite("Here is my receipt",true)).toBe(false);
  expect(authorizesInventoryWrite("What if I bought 10 gallons of milk?",false)).toBe(false);
  expect(authorizesInventoryWrite("Please review only, do not update inventory",true)).toBe(false);
  expect(authorizesInventoryWrite("Can you update inventory?",false)).toBe(false);
 });
});
