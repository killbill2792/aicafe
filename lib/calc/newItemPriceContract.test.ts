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
 it("never proposes a partial price below known ingredient and packaging cost",()=>{
  // Regression: $1 ingredients + $3 packaging used to yield $3.25.
  const result=calculateNewItemPrice({...base,ingredientCostCents:100,
    packagingCents:300,units30d:null,labor30dCents:null,monthlyBillsCents:null});
  expect(result.knownUnitCostCents).toBe(400);
  expect(result.suggestedPriceCents).toBeGreaterThanOrEqual(400);
  expect(result.floorCents).toBeGreaterThanOrEqual(400);
  expect(result.highCents).toBeGreaterThanOrEqual(result.floorCents);
  expect(result.fullCostCents).toBeNull();
  expect(result.missing).toContain("monthlyBills");
 });
 it("includes known partial rent and labor per item in the minimum price without claiming complete costs",()=>{
  const result=calculateNewItemPrice({...base,ingredientCostCents:100,packagingCents:300,
    units30d:100,labor30dCents:10000,monthlyBillsCents:null,knownPartialBillsCents:10000});
  expect(result.knownUnitCostCents).toBe(600);
  expect(result.suggestedPriceCents).toBeGreaterThanOrEqual(600);
  expect(result.floorCents).toBeGreaterThanOrEqual(600);
  expect(result.fullCostCents).toBeNull();
  expect(result.result.tier).toBe("partial");
 });
 it("never calls known rent-only coverage complete even when labor is recorded",()=>{
  const result=contributionCoverage({priceCents:700,unitCostCents:100,packagingCents:300,
    laborCents:10000,billsCents:20000,billsComplete:false,days:20});
  expect(result).toMatchObject({overheadCoverage:"partial",
    overheadPerDayCents:null,drinksPerDayToCoverOverhead:null,
    knownOverheadPerDayCents:1500,drinksPerDayToCoverKnownOverhead:5});
 });
 it("does not present partial overhead as total business break-even",()=>{
  expect(contributionCoverage({priceCents:500,unitCostCents:145,packagingCents:0,laborCents:1064516,
    billsCents:null,days:22})).toMatchObject({contributionCents:355,overheadCoverage:"partial",overheadPerDayCents:null,
    drinksPerDayToCoverOverhead:null,knownOverheadPerDayCents:48387,drinksPerDayToCoverKnownOverhead:137});
 });
});
