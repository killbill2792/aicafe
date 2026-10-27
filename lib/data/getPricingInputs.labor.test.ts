import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {monthlyPayrollFromDays} from "./getPricingInputs";

describe("pricing rollup payroll quality",()=>{
  const known={wagesCents:3500,staffTaxCents:420,
    laborWageStatus:"actual" as const,staffTaxStatus:"actual" as const};
  it("keeps numeric known-only wages unknown when staff pay is missing",()=>{
    const r=monthlyPayrollFromDays([known,{...known,laborWageStatus:"missing"}],1);
    expect(r).toEqual({monthlyWagesCents:null,monthlyStaffCostCents:null,
      payrollCostsStatus:"missing"});
  });
  it("does not treat NULL, absent status, or empty periods as zero payroll",()=>{
    for(const days of [[],[{...known,wagesCents:null}],[{...known,laborWageStatus:undefined}]]){
      expect(monthlyPayrollFromDays(days,1).monthlyStaffCostCents).toBeNull();
    }
  });
  it("keeps complete recorded payroll and estimated labor distinct",()=>{
    expect(monthlyPayrollFromDays([known],1)).toMatchObject({
      monthlyWagesCents:3500,monthlyStaffCostCents:3920,payrollCostsStatus:"actual"});
    expect(monthlyPayrollFromDays([{...known,laborWageStatus:"estimate"}],1)
      .payrollCostsStatus).toBe("estimated");
  });
});
