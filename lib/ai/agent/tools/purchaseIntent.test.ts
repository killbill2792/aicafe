import {describe,expect,it} from "vitest";
import {authorizesInventoryWrite,ownerTextSupportsTypedLine} from "./purchaseIntent";
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
 });

 it("accepts clear owner instructions, no repeat click",()=>{
  expect(authorizesInventoryWrite("I bought 10 gallons of milk today",false)).toBe(true);
  expect(authorizesInventoryWrite("Please add these purchases to inventory.",true)).toBe(true);
  expect(authorizesInventoryWrite("Record this receipt as stock purchases",true)).toBe(true);
 });
 it("never treats bare upload, uncertain language, or negation as authority",()=>{
  expect(authorizesInventoryWrite("Here is my receipt",true)).toBe(false);
  expect(authorizesInventoryWrite("What if I bought 10 gallons of milk?",false)).toBe(false);
  expect(authorizesInventoryWrite("Please review only, do not update inventory",true)).toBe(false);
  expect(authorizesInventoryWrite("Can you update inventory?",false)).toBe(false);
 });
});
