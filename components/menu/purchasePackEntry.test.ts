import {describe,expect,it} from "vitest";
import {parsePurchasePack,purchasePackLabel} from "./purchasePackEntry";

describe("café pantry purchase-pack entry",()=>{
 it("expands cases into existing canonical volume quantity",()=>{
  expect(parsePurchasePack("12 × 32 fluid ounces cans","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("12 x 32 oz","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("1 × 1 gallon","ml")).toEqual({packQuantity:1,packUnit:"gal"});
 });
 it("preserves existing case-sized starter packs when editing a purchase price",()=>{
  expect(parsePurchasePack("1 case(1000)","each")).toEqual({packQuantity:1,packUnit:"case(1000)"});
  expect(parsePurchasePack("2 case(100)","each")).toEqual({packQuantity:2,packUnit:"case(100)"});
  expect(parsePurchasePack(purchasePackLabel(1,"case(1000)","each"),"each")).toEqual({packQuantity:1,packUnit:"case(1000)"});
  expect(parsePurchasePack("1 case(1000)","g")).toBeNull();
 });
 it("handles weight ounces differently from liquid ounces",()=>{
  expect(parsePurchasePack("2 x 16 ounces","g")).toEqual({packQuantity:32,packUnit:"oz_wt"});
  expect(parsePurchasePack("2 x 16 fluid ounces","g")).toBeNull();
  expect(parsePurchasePack("250 grams","ml")).toBeNull();
 });
 it("accepts the Spanish and Arabic pack examples shown to owners",()=>{
  expect(parsePurchasePack("12 × 32 onzas líquidas","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("2 × 5 libras","g")).toEqual({packQuantity:10,packUnit:"lb"});
  expect(parsePurchasePack("12 × 32 أونصة سائلة","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("2 × 5 أرطال","g")).toEqual({packQuantity:10,packUnit:"lb"});
  expect(parsePurchasePack("١٢ × ٣٢ أونصة سائلة","ml")).toEqual({packQuantity:384,packUnit:"fl_oz"});
  expect(parsePurchasePack("12 unidades","each")).toEqual({packQuantity:12,packUnit:"each"});
 });
 it("keeps purchased price unknown for empty or unsupported packs",()=>{
  expect(parsePurchasePack("","ml")).toBeNull();
  expect(parsePurchasePack("0 x 32 oz","ml")).toBeNull();
  expect(parsePurchasePack("12 cases of ??","each")).toBeNull();
  expect(parsePurchasePack("NaN grams","g")).toBeNull();
 });
 it("round trips long and fractional saved quantities across languages",()=>{
  const examples:[number,string,"ml"|"g"|"each",string][]=[
   [1000,"ml","ml","en"],[1.5,"l","ml","es"],[1.5,"l","ml","ar"],
   [384,"fl_oz","ml","es"],[2.5,"oz_wt","g","es"],[2.5,"oz_wt","g","ar"],
   [12,"each","each","es"],[12,"each","each","ar"],
   [1,"case(1000)","each","en"],
  ];
  for(const [quantity,unit,baseUnit,locale] of examples){
   expect(parsePurchasePack(purchasePackLabel(quantity,unit,baseUnit,locale),baseUnit))
    .toEqual({packQuantity:quantity,packUnit:unit});
  }
 });
 it("displays a plain-language unit without changing the stored representation",()=>{
  expect(purchasePackLabel(384,"fl_oz","ml")).toBe("384 fluid ounces");
  expect(purchasePackLabel(32,"oz_wt","g")).toBe("32 ounces by weight");
  expect(purchasePackLabel(384,"fl_oz","ml","es")).toContain("onzas");
  expect(purchasePackLabel(384,"fl_oz","ml","ar")).toContain("أونصة");
  expect(purchasePackLabel(null,null,"ml")).toBe("");
 });
});
