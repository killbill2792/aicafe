import {describe,it,expect} from "vitest";
import {ownerSpecifiedMonthlyBills,ownerSpecifiedPercent} from "./pricingOwnerEvidence";
describe("owner pricing evidence",()=>{
 it("rejects a labor amount misrepresented as a monthly bills total",()=>{
  expect(ownerSpecifiedMonthlyBills(["labor 13000/month"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["wages $13,000 per month"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["payroll $13,000 per month"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["labor costs $13,000"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["payroll totals $13,000 and utilities are unknown"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["salary expenses $13,000"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["nómina 13.000 al mes"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["الرواتب ١٣٠٠٠ شهريًا"],1300000)).toBe(false);
 });
 it("accepts the amount only alongside bills, rent, overhead or utilities, including card prefixes",()=>{
  for(const text of ["Monthly bills: $13,000","rent $13,000","overhead 13,000",
   "utilities $13,000","Facturas mensuales: 13.000","alquiler 13.000",
   "الفواتير الشهرية: ١٣٠٠٠","الإيجار ١٣٠٠٠"]){
   expect(ownerSpecifiedMonthlyBills([text],1300000),text).toBe(true);
  }
  expect(ownerSpecifiedMonthlyBills(["labor $13,000; bills $8,360"],1300000)).toBe(false);
  expect(ownerSpecifiedMonthlyBills(["labor $13,000; bills $8,360"],836000)).toBe(true);
  expect(ownerSpecifiedMonthlyBills(["bills $900"],1300000)).toBe(false);
 });
 it("recognizes EN/ES/AR explicitly stated cost targets and operating margins only",()=>{
  for(const text of ["drink cost 30%","costo de bebida 30%","تكلفة المشروب ٣٠٪"])
   expect(ownerSpecifiedPercent([text],30,"drinkCost"),text).toBe(true);
  for(const text of ["operating margin 25%","margen operativo 25%",
   "هامش الربح ٢٥٪"]){
   expect(ownerSpecifiedPercent([text],25,"operatingMargin"),text).toBe(true);
  }
  expect(ownerSpecifiedPercent(["labor 25%"],25,"operatingMargin")).toBe(false);
  expect(ownerSpecifiedPercent(["margen operativo 25%"],50,"operatingMargin")).toBe(false);
 });
});
