import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";

export type Hour = {date:string;hourLocal:number;locationId:string|null;netSalesCents:number;ordersCount:number};
export type StaffSales = {date:string;employeeId:string;netSalesCents:number;ordersCount:number};
export type Payroll = {employeeId:string;payPeriodEnd:string;regularCents:number|null;overtimeCents:number|null;doubleOvertimeCents:number|null;grossCents:number|null;employeeTaxCents:number|null;employerTaxCents:number|null;netCents:number|null;source:string|null};
export type PeakHourFacts = {hours:Hour[]};
export type EmployeeSalesFacts = {employees:StaffSales[]};
export type PayrollFacts = {payPeriods:Payroll[]};
const PAGE_SIZE=500;
const MAX_PAGES=40;
type Page<T>={data:T[]|null;error:unknown};
type Paged<T>={rows:T[];error:boolean;truncated:boolean};
async function readPages<T>(load:(start:number,end:number)=>PromiseLike<Page<T>>):Promise<Paged<T>> {
 const rows:T[]=[];
 for(let page=0;page<MAX_PAGES;page++){
  const {data,error}=await load(page*PAGE_SIZE,(page+1)*PAGE_SIZE-1);
  if(error)return {rows:[],error:true,truncated:false};
  if(!data)return {rows:[],error:true,truncated:false};
  rows.push(...data);
  if(data.length<PAGE_SIZE)return {rows,error:false,truncated:false};
 }
 // Never expose a saturated dataset as complete, even if exactly MAX_ROWS.
 return {rows:[],error:false,truncated:true};
}
function missing<T>(reason:string):KnownSlice<T> {
 return {available:false,value:null,quality:{level:"low",missingInputs:[reason],estimatedInputs:[],staleInputs:[]}};
}
function known<T>(value:T, missingInputs:string[]=[]):KnownSlice<T> {
 return {available:true,value,quality:{level:missingInputs.length?"medium":"high",missingInputs,estimatedInputs:[],staleInputs:[]}};
}
const date=/^\d{4}-\d{2}-\d{2}$/;
function checkPeriod(p:CafeStatePeriod){
 const valid=(d:string)=>date.test(d)&&new Date(d+"T12:00:00Z").toISOString().slice(0,10)===d;
 if(!valid(p.from)||!valid(p.to)||p.from>p.to||Date.parse(p.to)-Date.parse(p.from)>366*86400000)
  throw new Error("Invalid POS reporting period");
}
function integer(v:unknown):number {
 const n=Number(v);
 if(v==null||!Number.isSafeInteger(n))throw new Error("Invalid canonical POS integer");
 return n;
}
function cents(v:unknown):number|null{return v==null?null:integer(v);}
function missingDays(p:CafeStatePeriod,dates:string[],key:string){
 const expected=1+Math.round((Date.parse(p.to)-Date.parse(p.from))/86400000);
 return new Set(dates).size<expected?[key]:[];
}
export function posFactReaders(db:SupabaseClient,businessId:string){
 return {
  async peakHours(period:CafeStatePeriod):Promise<KnownSlice<PeakHourFacts>>{
   checkPeriod(period);
   const found=await readPages<{business_date:string;hour_local:number;location_id:string|null;net_sales_cents:unknown;orders_count:unknown}>((start,end)=>
     db.from("hourly_sales_rollup").select("business_date,hour_local,location_id,net_sales_cents,orders_count")
     .eq("business_id",businessId).gte("business_date",period.from).lte("business_date",period.to)
     .order("business_date").order("hour_local").order("location_id")
     .order("net_sales_cents").order("orders_count").range(start,end));
   if(found.error)return missing("hourlySalesUnavailable");
   if(found.truncated)return missing("hourlySalesPageLimit");
   if(!found.rows.length)return missing("noHourlySalesFacts");
   try{
    const hours=found.rows.map(r=>({date:r.business_date,hourLocal:integer(r.hour_local),locationId:r.location_id,
      netSalesCents:integer(r.net_sales_cents),ordersCount:integer(r.orders_count)}));
    return known({hours},missingDays(period,hours.map(r=>r.date),"hourlySalesDatesNotObserved"));
   }catch{return missing("unsafeHourlySalesFacts");}
  },
  async employeeSales(period:CafeStatePeriod):Promise<KnownSlice<EmployeeSalesFacts>>{
   checkPeriod(period);
   const found=await readPages<{business_date:string;employee_id:string;net_sales_cents:unknown;orders_count:unknown}>((start,end)=>
     db.from("employee_sales_rollup").select("business_date,employee_id,net_sales_cents,orders_count")
     .eq("business_id",businessId).gte("business_date",period.from).lte("business_date",period.to)
     .order("business_date").order("employee_id").order("net_sales_cents").order("orders_count").range(start,end));
   if(found.error)return missing("employeeSalesUnavailable");
   if(found.truncated)return missing("employeeSalesPageLimit");
   if(!found.rows.length)return missing("noEmployeeSalesFacts");
   try{
    const employees=found.rows.map(r=>({date:r.business_date,employeeId:r.employee_id,
      netSalesCents:integer(r.net_sales_cents),ordersCount:integer(r.orders_count)}));
    return known({employees},missingDays(period,employees.map(r=>r.date),"employeeSalesDatesNotObserved"));
   }catch{return missing("unsafeEmployeeSalesFacts");}
  },
  async payrollFacts(period:CafeStatePeriod):Promise<KnownSlice<PayrollFacts>>{
   checkPeriod(period);
   const found=await readPages<{employee_id:string;pay_period_end:string;regular_cents:unknown;overtime_cents:unknown;double_overtime_cents:unknown;gross_cents:unknown;employee_tax_cents:unknown;employer_tax_cents:unknown;net_cents:unknown;source:string|null}>((start,end)=>
     db.from("employee_pay_period_facts").select("employee_id,pay_period_end,regular_cents,overtime_cents,double_overtime_cents,gross_cents,employee_tax_cents,employer_tax_cents,net_cents,source")
     .eq("business_id",businessId).gte("pay_period_end",period.from).lte("pay_period_end",period.to)
     .order("pay_period_end").order("employee_id").order("id").range(start,end));
   if(found.error)return missing("payrollFactsUnavailable");
   if(found.truncated)return missing("payrollFactsPageLimit");
   if(!found.rows.length)return missing("noPayrollPeriodFacts");
   try{
    return known({payPeriods:found.rows.map(r=>({employeeId:r.employee_id,payPeriodEnd:r.pay_period_end,
      regularCents:cents(r.regular_cents),overtimeCents:cents(r.overtime_cents),
      doubleOvertimeCents:cents(r.double_overtime_cents),grossCents:cents(r.gross_cents),
      employeeTaxCents:cents(r.employee_tax_cents),employerTaxCents:cents(r.employer_tax_cents),
      netCents:cents(r.net_cents),source:r.source}))});
   }catch{return missing("unsafePayrollFacts");}
  }
 };
}
