import {describe,it,expect} from "vitest";
import {menuPriceDelta,priceInputCents,priceEditString,summarizeActualMenuSales} from "./menuPriceProposal";
describe("pure proposal price and sales calculations",()=>{
 it("keeps signed deltas in integer cents",()=>{
  expect(menuPriceDelta(450,500)).toEqual({deltaCents:50,increased:true});
  expect(menuPriceDelta(550,400)).toEqual({deltaCents:-150,increased:false});
 });
 it("parses only valid owner dollar inputs",()=>{
  expect(priceInputCents("4.75")).toBe(475);
  expect(priceInputCents("4.755")).toBeNull();
  expect(priceInputCents("0")).toBeNull();
  expect(priceInputCents("1000.01")).toBeNull();
  expect(priceEditString(475)).toBe("4.75");
 });
 it("counts actual covered days only and keeps absent evidence unknown",()=>{
  const samples=[{businessDate:"2026-10-20",observation:{coverage:"actual",units:3,netSalesCents:1500}},
    {businessDate:"2026-10-21",observation:{coverage:"unavailable",units:999,netSalesCents:999999}}];
  expect(summarizeActualMenuSales(samples)).toEqual({coveredDays:1,observedUnits:3,observedRevenueCents:1500});
  expect(summarizeActualMenuSales([])).toEqual({coveredDays:0,observedUnits:null,observedRevenueCents:null});
 });
});
