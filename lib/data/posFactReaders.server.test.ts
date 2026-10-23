import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {posFactReaders} from "./posFactReaders.server";
import type {SupabaseClient} from "@supabase/supabase-js";
const period={from:"2026-08-22",to:"2026-08-22"};
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