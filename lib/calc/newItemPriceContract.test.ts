import {describe,it,expect} from "vitest";
import {calculateNewItemPrice,contributionCoverage} from "./newItemPrice";
describe("partial price recommendation",()=>{
 const base={ingredientCostCents:145,packagingCents:null,targetMarginPercent:null,labor30dCents:null,monthlyBillsCents:null,units30d:null,menuPricesCents:[300,400,500,700]};
 it("always produces a rounded floor and price range",()=>{
  const result=calculateNewItemPrice(base);
  expect(result).toMatchObject({rawFloorCents:414,rawTargetCents:483,rawHighCents:580,floorCents:425,highCents:600,result:{tier:"floor_only",floor:425,range:{low:425,high:600}}});
  expect(result.suggestedPriceCents).not.toBeNull();
 });
 it("upgrades tiers with usage and overhead evidence",()=>{
  expect(calculateNewItemPrice({...base,units30d:1000}).result.tier).toBe("partial");
  expect(calculateNewItemPrice({...base,units30d:1000,labor30dCents:90000,monthlyBillsCents:60000,packagingCents:20}).result.tier).toBe("full");
 });
 it("does not present partial overhead as total business break-even",()=>{
  expect(contributionCoverage({priceCents:500,unitCostCents:145,packagingCents:0,laborCents:1064516,
    billsCents:null,days:22})).toMatchObject({contributionCents:355,overheadCoverage:"partial",overheadPerDayCents:null,
    drinksPerDayToCoverOverhead:null,knownOverheadPerDayCents:48387,drinksPerDayToCoverKnownOverhead:137});
 });
});
