import {describe,expect,it} from "vitest";
import {parsePurchasePack,purchasePackLabel} from "./purchasePackEntry";

describe("café pantry purchase-pack entry",()=>{
 it("expands cases into existing canonical volume quantity",()=>{
  expect(parsePurchasePack("12 × 32 fluid ounces cans","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("12 x 32 oz","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("1 × 1 gallon","ml")).toEqual({packQuantity:1,packUnit:"gal"});
 });
 it("handles weight ounces differently from liquid ounces",()=>{
  expect(parsePurchasePack("2 x 16 ounces","g")).toEqual({packQuantity:32,packUnit:"oz_wt"});
  expect(parsePurchasePack("2 x 16 fluid ounces","g")).toBeNull();
  expect(parsePurchasePack("250 grams","ml")).toBeNull();
 });
 it("keeps purchased price unknown for empty or unsupported packs",()=>{
  expect(parsePurchasePack("","ml")).toBeNull();
  expect(parsePurchasePack("0 x 32 oz","ml")).toBeNull();
  expect(parsePurchasePack("12 cases of ??","each")).toBeNull();
  expect(parsePurchasePack("NaN grams","g")).toBeNull();
 });
 it("displays a plain-language unit without changing the stored representation",()=>{
  expect(purchasePackLabel(384,"fl_oz","ml")).toBe("384 fluid ounces");
  expect(purchasePackLabel(32,"oz_wt","g")).toBe("32 ounces by weight");
  expect(purchasePackLabel(null,null,"ml")).toBe("");
 });
});
