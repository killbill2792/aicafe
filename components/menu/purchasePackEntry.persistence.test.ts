import {describe,it,expect} from "vitest";
import {packToCostPerBaseMicros} from "@/lib/calc/recipeUnits";
import {parsePurchasePackWithOriginal,purchasePackLabel} from "./purchasePackEntry";

describe("owner purchase-pack factor persistence",()=>{
 it("stores 12 × 32 liquid ounces separately from canonical 384 and reopens the breakdown",()=>{
  const entered=parsePurchasePackWithOriginal("12 × 32 fluid ounces","ml");
  expect(entered).toEqual({packQuantity:384,packUnit:"fl_oz",
   originalPack:{count:12,unitQuantity:32,unit:"fl_oz"}});
  const saved=JSON.parse(JSON.stringify(entered!));
  const reopened=purchasePackLabel(saved.packQuantity,saved.packUnit,"ml","en",saved.originalPack);
  expect(reopened).toBe("12 × 32 fluid ounces");
  const priceOnlyEdit=parsePurchasePackWithOriginal(reopened,"ml");
  expect(priceOnlyEdit).toEqual(entered);
  expect(packToCostPerBaseMicros(priceOnlyEdit!.packQuantity,priceOnlyEdit!.packUnit,1234,"ml"))
   .toEqual(packToCostPerBaseMicros(saved.packQuantity,saved.packUnit,1234,"ml"));
 });
 it.each(["en","es","ar"] as const)("reopens the same original factors in %s",locale=>{
  const before=parsePurchasePackWithOriginal(locale==="es"?"12 × 32 onzas líquidas":locale==="ar"?"١٢ × ٣٢ أونصة سائلة":"12 × 32 fluid ounces","ml")!;
  const label=purchasePackLabel(before.packQuantity,before.packUnit,"ml",locale,before.originalPack);
  expect(label).toContain("12 × 32");
  expect(parsePurchasePackWithOriginal(label,"ml")).toEqual(before);
 });
 it("does not invent a layout for older normalized prices or case(1000) packaging",()=>{
  expect(purchasePackLabel(384,"fl_oz","ml","en",null)).toBe("384 fluid ounces");
  expect(parsePurchasePackWithOriginal(purchasePackLabel(1,"case(1000)","each"),"each"))
   .toEqual({packQuantity:1,packUnit:"case(1000)"});
  expect(parsePurchasePackWithOriginal("1 case(100)","each"))
   .toEqual({packQuantity:1,packUnit:"case(100)"});
 });
 it("factorized save/reopen/price-only edit is parseable across every supported unit and EN/ES/AR grammar",()=>{
  const specs:[string,"ml"|"g"|"each",string][]=[
   ["fl_oz","ml","fl oz"],["ml","ml","ml"],["l","ml","liters"],
   ["gal","ml","gallons"],["qt","ml","quarts"],
   ["oz_wt","g","ounces by weight"],["g","g","grams"],
   ["kg","g","kilograms"],["lb","g","pounds"],
   ["each","each","pieces"],["dozen","each","dozen"],
   ["case(100)","each","case(100)"],["case(1000)","each","case(1000)"],
  ];
  for(const [unit,baseUnit,typedUnit] of specs){
   for(const eachUnit of [1,2,32]){
    const typed=parsePurchasePackWithOriginal(`12 × ${eachUnit} ${typedUnit}`,baseUnit);
    expect(typed?.packUnit,typedUnit).toBe(unit);
    expect(typed?.originalPack,typedUnit).toEqual({count:12,unitQuantity:eachUnit,unit});
    for(const locale of ["en","es","ar"]){
     const reopened=purchasePackLabel(typed!.packQuantity,typed!.packUnit,baseUnit,locale,typed!.originalPack);
     expect(reopened,locale+" "+unit).toContain(`12 × ${eachUnit} `);
     expect(parsePurchasePackWithOriginal(reopened,baseUnit),locale+" "+unit).toEqual(typed);
    }
   }
  }
 });
 it("never accepts malformed or cross-family factors as cost metadata",()=>{
  expect(parsePurchasePackWithOriginal("12 × 32 fluid ounces","g")).toBeNull();
  expect(parsePurchasePackWithOriginal("0 × 32 fluid ounces","ml")).toBeNull();
  expect(parsePurchasePackWithOriginal("12 × 32 grams","ml")).toBeNull();
 });
});
