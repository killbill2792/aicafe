import {describe,expect,it} from "vitest";
import {authorizesInventoryWrite,ownerTextSupportsTypedLine,receivedPurchaseDocument,isPurchaseCorrection} from "./purchaseIntent";
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
 });
 it("never treats bare upload, uncertain language, or negation as authority",()=>{
  expect(authorizesInventoryWrite("Here is my receipt",true)).toBe(false);
  expect(authorizesInventoryWrite("What if I bought 10 gallons of milk?",false)).toBe(false);
  expect(authorizesInventoryWrite("Please review only, do not update inventory",true)).toBe(false);
  expect(authorizesInventoryWrite("Can you update inventory?",false)).toBe(false);
 });
});
