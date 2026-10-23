import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
const guard=vi.hoisted(()=>({unverified:vi.fn()}));
vi.mock("@/lib/pos/toast/reportingCoverage",()=>({unverifiedToastSalesDates:guard.unverified}));
vi.mock("server-only",()=>({}));
import {posFactReaders} from "./posFactReaders.server";
import type {SupabaseClient} from "@supabase/supabase-js";
const period={from:"2026-08-22",to:"2026-08-22"};
beforeEach(()=>{guard.unverified.mockReset();guard.unverified.mockResolvedValue(new Set());});
afterEach(()=>vi.unstubAllEnvs());
function mockDatabase(rows:Record<string,unknown>[],tableExpected:string) {
 const ranges:number[][]=[];
 const db={from:(table:string)=>{
  expect(table).toBe(tableExpected);
  const query={
   select:()=>query,eq:()=>query,gte:()=>query,lte:()=>query,order:()=>query,
   range:async(start:number,end:number)=>{ranges.push([start,end]);return {data:rows.slice(start,end+1),error:null};}
  };
  return query;
 }} as unknown as SupabaseClient;
 return {db,ranges};
}
describe("POS fact readers avoid PostgREST's one-thousand-row cap",()=>{
 it("paginates hourly facts past 1,000 rows without losing totals",async()=>{
  const rows=Array.from({length:1205},(_,i)=>({business_date:period.from,
   hour_local:i%24,location_id:null,net_sales_cents:100,orders_count:1}));
  const {db,ranges}=mockDatabase(rows,"hourly_sales_rollup");
  const result=await posFactReaders(db,"b").peakHours(period);
  expect(result.available).toBe(true);
  if(result.available)expect(result.value.hours).toHaveLength(1205);
  expect(ranges).toEqual([[0,499],[500,999],[1000,1499]]);
 });
 it("never reports saturated reads as complete",async()=>{
  const rows=Array.from({length:20_000},()=>({business_date:period.from,hour_local:1,
   location_id:null,net_sales_cents:100,orders_count:1}));
  const {db}=mockDatabase(rows,"hourly_sales_rollup");
  const result=await posFactReaders(db,"b").peakHours(period);
  expect(result.available).toBe(false);
  expect(result.quality.missingInputs).toContain("hourlySalesPageLimit");
 });
 it("excludes independently unverified Toast days from both sales projections",async()=>{
   vi.stubEnv("TOAST_PILOT_IMPORT_ENABLED","true");
   guard.unverified.mockResolvedValue(new Set([period.from]));
   const h=mockDatabase([{business_date:period.from,hour_local:10,
     location_id:null,net_sales_cents:500,orders_count:1}],"hourly_sales_rollup");
   const staff=mockDatabase([{business_date:period.from,employee_id:"e",net_sales_cents:500,
     orders_count:1}],"employee_sales_rollup");
   const hourly=await posFactReaders(h.db,"b").peakHours(period);
   const employees=await posFactReaders(staff.db,"b").employeeSales(period);
   expect(hourly.available).toBe(false);
   expect(employees.available).toBe(false);
   expect(hourly.quality.missingInputs).toContain("toastSalesAwaitingIndependentReview");
   expect(employees.quality.missingInputs).toContain("toastSalesAwaitingIndependentReview");
 });
 it("flags partial verification without claiming the entire range",async()=>{
   vi.stubEnv("TOAST_PILOT_IMPORT_ENABLED","true");
   guard.unverified.mockResolvedValue(new Set([period.from]));
   const longer={from:period.from,to:"2026-08-23"};
   const rows=[{business_date:period.from,hour_local:10,location_id:null,net_sales_cents:500,orders_count:1},
     {business_date:"2026-08-23",hour_local:11,location_id:null,net_sales_cents:700,orders_count:2}];
   const {db}=mockDatabase(rows,"hourly_sales_rollup");
   const result=await posFactReaders(db,"b").peakHours(longer);
   expect(result.available).toBe(true);
   if(result.available)expect(result.value.hours).toEqual([{date:"2026-08-23",
     hourLocal:11,locationId:null,netSalesCents:700,ordersCount:2}]);
   expect(result.quality.missingInputs).toContain("toastSalesAwaitingIndependentReview");
 });
 it("fails closed if Toast verification is unavailable",async()=>{
   vi.stubEnv("TOAST_PILOT_IMPORT_ENABLED","true");
   guard.unverified.mockRejectedValue(new Error("verification down"));
   const {db}=mockDatabase([],"hourly_sales_rollup");
   const result=await posFactReaders(db,"b").peakHours(period);
   expect(result.available).toBe(false);
   expect(result.quality.missingInputs).toEqual(["toastSalesVerificationUnavailable"]);
 });
 it("preserves nullable payroll evidence and paginates it",async()=>{
  const rows=Array.from({length:1001},(_,i)=>({employee_id:"e",pay_period_end:period.from,
   regular_cents:100,overtime_cents:null,double_overtime_cents:null,gross_cents:100,
   employee_tax_cents:null,employer_tax_cents:null,net_cents:null,source:"toast",id:String(i)}));
  const {db}=mockDatabase(rows,"employee_pay_period_facts");
  const result=await posFactReaders(db,"b").payrollFacts(period);
  expect(result.available).toBe(true);
  if(result.available){
   expect(result.value.payPeriods).toHaveLength(1001);
   expect(result.value.payPeriods[0].netCents).toBeNull();
   expect(result.quality.missingInputs).toContain("payrollUnknown:netCents");
   expect(result.quality.missingInputs).toContain("payrollUnknown:employeeTaxCents");
  }
 });
});