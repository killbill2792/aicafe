import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
const guard=vi.hoisted(()=>({unverified:vi.fn(),flags:vi.fn()}));
vi.mock("@/lib/pos/toast/reportingCoverage",()=>({unverifiedToastSalesDates:guard.unverified,toastDayFlags:guard.flags}));
vi.mock("server-only",()=>({}));
import {posFactReaders} from "./posFactReaders.server";
import type {SupabaseClient} from "@supabase/supabase-js";
const period={from:"2026-08-22",to:"2026-08-22"};
beforeEach(()=>{guard.unverified.mockReset();guard.unverified.mockResolvedValue(new Set());guard.flags.mockReset();guard.flags.mockResolvedValue([]);});
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
 it("later POS page throw preserves previously loaded facts and marks partial",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","false");
  const rows=Array.from({length:500},()=>({business_date:period.from,
    hour_local:10,location_id:null,net_sales_cents:100,orders_count:1}));
  const db={from:()=>{
    const query={select:()=>query,eq:()=>query,gte:()=>query,lte:()=>query,order:()=>query,
      range:async(start:number)=>{if(start>0)throw new Error("network timeout");
        return {data:rows,error:null};}};
    return query;
  }} as unknown as SupabaseClient;
  const result=await posFactReaders(db,"b").peakHours(period);
  expect(result.available).toBe(true);
  if(result.available)expect(result.value.hours).toHaveLength(500);
  expect(result.quality.missingInputs).toContain("hourlySalesUnavailable");
 });
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
  expect(result.available).toBe(true);
  expect(result.quality.missingInputs).toContain("hourlySalesPageLimit");
 });
 it("retains failed Toast day facts in both sales projections",async()=>{
   vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
   guard.flags.mockResolvedValue([{date:period.from,status:"failed",needsLook:false}]);
   guard.unverified.mockResolvedValue(new Set([period.from]));
   const h=mockDatabase([{business_date:period.from,hour_local:10,
     location_id:null,net_sales_cents:500,orders_count:1}],"hourly_sales_rollup");
   const staff=mockDatabase([{business_date:period.from,employee_id:"e",net_sales_cents:500,
     orders_count:1}],"employee_sales_rollup");
   const hourly=await posFactReaders(h.db,"b").peakHours(period);
   const employees=await posFactReaders(staff.db,"b").employeeSales(period);
   expect(hourly.available).toBe(true);
   expect(employees.available).toBe(true);
   if(hourly.available)expect(hourly.value.hours[0].netSalesCents).toBe(500);
   if(employees.available)expect(employees.value.employees[0].netSalesCents).toBe(500);
   expect(hourly.quality.missingInputs).toContain("toastImportIncompleteDays:1:"+period.from+":0");
   expect(employees.quality.missingInputs).toContain("toastImportIncompleteDays:1:"+period.from+":0");
 });
 it("flags partial verification without claiming the entire range",async()=>{
   vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
   guard.flags.mockResolvedValue([{date:period.from,status:"failed",needsLook:false}]);
   guard.unverified.mockResolvedValue(new Set([period.from]));
   const longer={from:period.from,to:"2026-08-23"};
   const rows=[{business_date:period.from,hour_local:10,location_id:null,net_sales_cents:500,orders_count:1},
     {business_date:"2026-08-23",hour_local:11,location_id:null,net_sales_cents:700,orders_count:2}];
   const {db}=mockDatabase(rows,"hourly_sales_rollup");
   const result=await posFactReaders(db,"b").peakHours(longer);
   expect(result.available).toBe(true);
   if(result.available)expect(result.value.hours).toMatchObject([{date:"2026-08-22",netSalesCents:500},
      {date:"2026-08-23",netSalesCents:700}]);
   expect(result.quality.missingInputs).toContain("toastImportIncompleteDays:1:2026-08-22:0");
 });
 it("status read fails keeps stored hours with one warning",async()=>{
   vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
   guard.flags.mockRejectedValue(new Error("status down"));
   const {db}=mockDatabase([{business_date:period.from,hour_local:10,
     location_id:null,net_sales_cents:500,orders_count:1}],"hourly_sales_rollup");
   const result=await posFactReaders(db,"b").peakHours(period);
   expect(result.available).toBe(true);
   if(result.available)expect(result.value.hours).toHaveLength(1);
   expect(result.quality.missingInputs).toEqual(["toastDayStatusUnavailable"]);
 });
 it("keeps an imported Toast day in projections with an explicit mismatch warning",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  guard.unverified.mockResolvedValue(new Set([period.from]));
  guard.flags.mockResolvedValue([{date:period.from,status:"imported",needsLook:true}]);
  const {db}=mockDatabase([{business_date:period.from,hour_local:10,location_id:null,
    net_sales_cents:500,orders_count:1}],"hourly_sales_rollup");
  const result=await posFactReaders(db,"b").peakHours(period);
  expect(result.available).toBe(true);
  if(result.available)expect(result.value.hours).toHaveLength(1);
  expect(result.quality.missingInputs).toContain("toastDaysNeedLook:1:"+period.from+":0");
 });
 it("keeps successfully loaded first page when second page fails",async()=>{
  const rows=Array.from({length:500},()=>({business_date:period.from,
   hour_local:10,location_id:null,net_sales_cents:125,orders_count:1}));
  const db={from:()=>{
   const q={select:()=>q,eq:()=>q,gte:()=>q,lte:()=>q,order:()=>q,
    range:async(start:number)=>start===0?{data:rows,error:null}:{data:null,error:{message:"network failed"}}};
   return q;
  }} as unknown as SupabaseClient;
  const result=await posFactReaders(db,"business").peakHours(period);
  expect(result.available).toBe(true);
  if(result.available)expect(result.value.hours).toHaveLength(500);
  expect(result.quality.missingInputs).toContain("hourlySalesUnavailable");
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