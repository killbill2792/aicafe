import type { PeakHourFacts, EmployeeSalesFacts, PayrollFacts } from "@/lib/data/posFactReaders.server";

/** Deterministic, bounded business math reused by all conversational POS tools.
 * The input KnownSlice may contain many rows; these summaries never send them to an LLM.
 */
function sumSafe(values:number[]):number {
 const total=values.reduce((a,b)=>a+b,0);
 if(!Number.isSafeInteger(total))throw new Error("POS fact summary exceeds safe integer cents");
 return total;
}
export function summarizePeakHours(facts:PeakHourFacts){
 const byHour=new Map<number,{hourLocal:number;netSalesCents:number;ordersCount:number}>();
 for(const row of facts.hours){
  const item=byHour.get(row.hourLocal)??{hourLocal:row.hourLocal,netSalesCents:0,ordersCount:0};
  item.netSalesCents=sumSafe([item.netSalesCents,row.netSalesCents]);
  item.ordersCount=sumSafe([item.ordersCount,row.ordersCount]);
  byHour.set(row.hourLocal,item);
 }
 const ranked=[...byHour.values()].sort((a,b)=>b.netSalesCents-a.netSalesCents||a.hourLocal-b.hourLocal);
 return {recordedRows:facts.hours.length,observedBusinessDays:new Set(facts.hours.map(r=>r.date)).size,
  totalNetSalesCents:sumSafe(facts.hours.map(r=>r.netSalesCents)),
  totalOrdersCount:sumSafe(facts.hours.map(r=>r.ordersCount)),
  topHours:ranked.slice(0,12),otherHoursOmitted:ranked.length>12};
}
export function summarizeEmployeeSales(facts:EmployeeSalesFacts){
 const byEmployee=new Map<string,{employeeId:string;netSalesCents:number;ordersCount:number}>();
 for(const row of facts.employees){
  const item=byEmployee.get(row.employeeId)??{employeeId:row.employeeId,netSalesCents:0,ordersCount:0};
  item.netSalesCents=sumSafe([item.netSalesCents,row.netSalesCents]);
  item.ordersCount=sumSafe([item.ordersCount,row.ordersCount]);
  byEmployee.set(row.employeeId,item);
 }
 const ranked=[...byEmployee.values()].sort((a,b)=>b.netSalesCents-a.netSalesCents||a.employeeId.localeCompare(b.employeeId));
 return {recordedRows:facts.employees.length,observedBusinessDays:new Set(facts.employees.map(r=>r.date)).size,
  totalAttributedNetSalesCents:sumSafe(facts.employees.map(r=>r.netSalesCents)),
  employeeCount:ranked.length,topEmployees:ranked.slice(0,10),employeesOmitted:ranked.length>10};
}
export function summarizePayrollFacts(facts:PayrollFacts){
 const all=facts.payPeriods;
 const nullableTotal=(k:"grossCents"|"netCents"|"regularCents"|"overtimeCents"|"doubleOvertimeCents"|"employeeTaxCents"|"employerTaxCents")=>
  all.every(r=>r[k]!==null)?sumSafe(all.map(r=>r[k]!)):null;
 const ranked=[...all].sort((a,b)=>b.payPeriodEnd.localeCompare(a.payPeriodEnd)||a.employeeId.localeCompare(b.employeeId));
 return {recordedPayPeriods:all.length,employeeCount:new Set(all.map(r=>r.employeeId)).size,
  grossCents:nullableTotal("grossCents"),netCents:nullableTotal("netCents"),
  regularCents:nullableTotal("regularCents"),overtimeCents:nullableTotal("overtimeCents"),
  doubleOvertimeCents:nullableTotal("doubleOvertimeCents"),
  employeeTaxCents:nullableTotal("employeeTaxCents"),employerTaxCents:nullableTotal("employerTaxCents"),
  latestPayPeriods:ranked.slice(0,8).map(r=>({employeeId:r.employeeId,payPeriodEnd:r.payPeriodEnd,
     grossCents:r.grossCents,netCents:r.netCents,source:r.source})),payPeriodsOmitted:ranked.length>8};
}
