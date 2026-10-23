import {describe,it,expect} from "vitest";
import {summarizePeakHours,summarizeEmployeeSales,summarizePayrollFacts} from "./posFactSummaries";
describe("compact and exact model-facing POS evidence",()=>{
 it("aggregates all hours but emits at most 12 ranked hours",()=>{
  const hours=Array.from({length:1200},(_,i)=>({date:"2026-08-22",hourLocal:i%24,
   locationId:null,netSalesCents:100,ordersCount:1}));
  const result=summarizePeakHours({hours});
  expect(result.recordedRows).toBe(1200);
  expect(result.totalNetSalesCents).toBe(120000);
  expect(result.totalOrdersCount).toBe(1200);
  expect(result.topHours).toHaveLength(12);
  expect(result.otherHoursOmitted).toBe(true);
 });
 it("summarizes all employee rows without forwarding them",()=>{
  const employees=Array.from({length:1500},(_,i)=>({date:"2026-08-22",employeeId:String(i%30),
   netSalesCents:10,ordersCount:1}));
  const result=summarizeEmployeeSales({employees});
  expect(result.totalAttributedNetSalesCents).toBe(15000);
  expect(result.employeeCount).toBe(30);
  expect(result.topEmployees).toHaveLength(10);
 });
 it("preserves unknown payroll values as null rather than a fabricated zero",()=>{
  const result=summarizePayrollFacts({payPeriods:[{employeeId:"e",payPeriodEnd:"2026-08-22",
   regularCents:100,overtimeCents:null,doubleOvertimeCents:null,grossCents:100,
   employeeTaxCents:null,employerTaxCents:null,netCents:null,source:"toast"}]});
  expect(result.grossCents).toBe(100);
  expect(result.netCents).toBeNull();
  expect(result.employeeTaxCents).toBeNull();
  expect(result.latestPayPeriods).toHaveLength(1);
 });
});