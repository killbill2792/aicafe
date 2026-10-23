import {describe,it,expect} from "vitest";
import {calculateComboTotals,suggestComboPrices} from "./menuCombo";
describe("combo numbers come from a single calculation",()=>{
 it("subtracts each component once and compares separately sold margin",()=>{
  const x=calculateComboTotals([{quantity:1,priceCents:625,costCents:117},{quantity:1,priceCents:350,costCents:123}],850);
  expect(x).toEqual({soldSeparatelyCents:975,comboPriceCents:850,savesCustomerCents:125,costCents:240,keepCents:610,keepPercent:72,separateKeepCents:735,separateKeepPercent:75});
 });
 it("uses quantity and never invents missing component cost",()=>{
  expect(calculateComboTotals([{quantity:2,priceCents:350,costCents:null}],600).costCents).toBeNull();
  expect(calculateComboTotals([{quantity:2,priceCents:350,costCents:125}],600).costCents).toBe(250);
 });
 it("does not mislabel a markup as a saving",()=>{
  expect(calculateComboTotals([{quantity:1,priceCents:500,costCents:100}],600).savesCustomerCents).toBe(-100);
  expect(suggestComboPrices(975)).toEqual([825,850,875]);
 });
});