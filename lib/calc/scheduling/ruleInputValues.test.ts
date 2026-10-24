import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {minutesToParts,partsToMinutes,wholeRuleValue,multiplierToBasisPoints,basisPointsToMultiplier,employerCostPercentFromInput} from "./ruleInputValues";

describe("Staff rule typed time and overtime settings",()=>{
 it("round-trips every minute within allowed weekly duration, not just 15/30/60 minute steps",()=>{
  for (let n=0;n<=10080;n++){
   const parts=minutesToParts(n);
   expect(partsToMinutes(String(parts.hours),String(parts.minutes),0,10080)).toBe(n);
  }
 });
 it("accepts Arabic and Persian numeric input, with minute overflow normalized into hours",()=>{
  expect(partsToMinutes("٥","٣٧",0,1440)).toBe(337);
  expect(partsToMinutes("۵","۳۷",0,1440)).toBe(337);
  expect(partsToMinutes("٠","٩٠",0,1440)).toBe(90);
  expect(wholeRuleValue("٢",1,30)).toBe(2);
 });
 it("rejects blank, noninteger, negative and beyond-policy durations",()=>{
  expect(partsToMinutes("5","",0,1440)).toBeNull();
  expect(partsToMinutes("5","0.5",0,1440)).toBeNull();
  expect(partsToMinutes("-1","20",0,1440)).toBeNull();
  expect(partsToMinutes("25","0",0,1440)).toBeNull();
  expect(partsToMinutes("1","0",60,1440)).toBe(60);
  expect(wholeRuleValue("0",1,30)).toBeNull();
  expect(wholeRuleValue("1.5",1,30)).toBeNull();
 });
 it("round-trips all persisted overtime basis points exactly",()=>{
  for(let bp=10000;bp<=50000;bp++){
   expect(multiplierToBasisPoints(basisPointsToMultiplier(bp))).toBe(bp);
  }
  expect(multiplierToBasisPoints("1.5")).toBe(15000);
  expect(multiplierToBasisPoints("2")).toBe(20000);
  expect(multiplierToBasisPoints("١٫٥".replace("٫","."))).toBe(15000);
  expect(multiplierToBasisPoints("1,875")).toBe(18750);
  for(const invalid of ["","0.9","5.0001","1.23456","Infinity","NaN","-1","2.5e1"]){
   expect(multiplierToBasisPoints(invalid)).toBeNull();
  }
 });
 it("accepts zero and localized percentage input without silently substituting a default",()=>{
  expect(employerCostPercentFromInput("0")).toBe(0);
  expect(employerCostPercentFromInput("٠")).toBe(0);
  expect(employerCostPercentFromInput("١٢٫٥")).toBe(12.5);
  expect(employerCostPercentFromInput("12,5")).toBe(12.5);
  expect(employerCostPercentFromInput("100")).toBe(100);
  for(const invalid of ["","-1","100.001","abc","Infinity","1e2"]){
   expect(employerCostPercentFromInput(invalid)).toBeNull();
  }
 });
 it("routes onboarding and Staff payroll to the same action and single business setting",()=>{
  const onboarding=readFileSync(join(process.cwd(),"components/onboarding/PayrollTaxForm.tsx"),"utf8");
  const staff=readFileSync(join(process.cwd(),"components/staff/PayrollCostCard.tsx"),"utf8");
  const action=readFileSync(join(process.cwd(),"lib/actions/payrollCosts.ts"),"utf8");
  for(const component of [onboarding,staff]){
   expect(component).toContain('import { savePayrollCostAssumption } from "@/lib/actions/payrollCosts"');
   expect(component).toContain("savePayrollCostAssumption({ employerCostPercent:");
  }
  expect(onboarding).not.toContain("setPayrollTaxRate(");
  expect(action).toContain("payroll_tax_rate: rate");
  expect(action).toContain('staff_tax_status !== "actual"');
 });
});
