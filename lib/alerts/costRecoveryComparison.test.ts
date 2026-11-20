import {describe,it,expect} from "vitest";
import {comparableRecoveryPeriods,verifiedRecoveryRatio} from "./costRecoveryComparison";
import type {BusinessSnapshot} from "@/lib/data/types";
describe("closed-period cost recovery",()=>{
 it("compares equally elapsed calendar days, including year boundary",()=>{
  expect(comparableRecoveryPeriods("2026-03-31")).toEqual({current:{from:"2026-03-01",to:"2026-03-28"},previous:{from:"2026-02-01",to:"2026-02-28"}});
  expect(comparableRecoveryPeriods("2026-01-03")?.previous.from).toBe("2025-12-01");
  expect(comparableRecoveryPeriods("2026-11-01")).toBeNull();
 });
 it("uses actual recorded contribution and refuses unknown or estimated inputs",()=>{
  const day={date:"2026-11-01",netSalesCents:1000,ingredientsCents:200,wagesCents:300,staffTaxCents:50,cardFeesCents:50,salesDataStatus:"actual",laborWageStatus:"actual",staffTaxStatus:"actual",cardFeesStatus:"actual"};
  const snapshot={monthKey:"2026-11",monthActualDays:[day],previousMonthDays:[],runningCostLines:[{categoryCode:"rent",amountCents:1000,isExpected:true,isMissing:false,isEstimate:false}],recoveryOrder:["rent"]} as unknown as BusinessSnapshot;
  const period={from:"2026-11-01",to:"2026-11-01"};
  expect(verifiedRecoveryRatio(snapshot,period)).toBe(.4);
  expect(verifiedRecoveryRatio(snapshot,{...period,to:"2026-11-02"})).toBeNull();
  expect(verifiedRecoveryRatio({...snapshot,monthActualDays:[{...snapshot.monthActualDays[0],cardFeesStatus:"estimated"}]},period)).toBeNull();
 });
});
