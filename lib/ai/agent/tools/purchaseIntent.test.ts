import {describe,expect,it} from "vitest";
import {authorizesInventoryWrite} from "./purchaseIntent";
describe("explicit owner-turn purchase authority",()=>{
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
