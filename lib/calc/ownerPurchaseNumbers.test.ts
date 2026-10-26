import {describe,it,expect} from "vitest";
import {parseOwnerPurchaseNumbers} from "./ownerPurchaseNumbers";

describe("inventory entry decimal typing",()=>{
 it("preserves the completed English cost 12.50 as 1,250 cents",()=>{
  expect(parseOwnerPurchaseNumbers({quantity:"1.5",cost:"12.50"},"en")).toEqual({
   numbers:{quantity:1.5,costCents:1250},error:null});
 });
 it("reads Spanish quantity commas",()=>{
  expect(parseOwnerPurchaseNumbers({quantity:"1,5",cost:""},"es")).toEqual({
   numbers:{quantity:1.5,costCents:null},error:null});
 });
 it("reads Arabic-Indic digits and decimal mark",()=>{
  expect(parseOwnerPurchaseNumbers({quantity:"١٫٥",cost:""},"ar")).toEqual({
   numbers:{quantity:1.5,costCents:null},error:null});
 });
 it("blocks only malformed entries without coercing them",()=>{
  expect(parseOwnerPurchaseNumbers({quantity:"1",cost:"nope"},"en").error).toBe("invalid_cost");
  expect(parseOwnerPurchaseNumbers({quantity:"",cost:"12.50"},"en").error).toBe("invalid_quantity");
 });
});
