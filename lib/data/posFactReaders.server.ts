import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";

type Hour={date:string;hourLocal:number;locationId:string|null;netSalesCents:number;ordersCount:number};
type StaffSales={date:string;employeeId:string;netSalesCents:number;ordersCount:number};
type Payroll={employeeId:string;payPeriodEnd:string;regularCents:number|null;overtimeCents:number|null;doubleOvertimeCents:number|null;grossCents:number|null;employeeTaxCents:number|null;employerTaxCents:number|null;netCents:number|null;source:string|null};
export type PeakHourFacts={hours:Hour[]};
export type EmployeeSalesFacts={employees:StaffSales[]};
export type PayrollFacts={payPeriods:Payroll[]};
function good<T>(value:T):KnownSlice<T>{return {available:true,value,quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}};}
function missing<T>(reason:string):KnownSlice<T>{return {available:false,value:null,quality:{level:"low",missingInputs:[reason],estimatedInputs:[],staleInputs:[]}};}
const date=/^\d{4}-\d{2}-\d{2}$/;
function checkPeriod(period:CafeStatePeriod){if(!date.test(period.from)||!date.test(period.to)||period.from>period.to)throw new Error("Invalid POS reporting period");}
export function posFactReaders(db:SupabaseClient,businessId:string){
 return {
  async peakHours(period:CafeStatePeriod):Promise<KnownSlice<PeakHourFacts>>{
   checkPeriod(period);
   const {data,error}=await db.from("hourly_sales_rollup").select("business_date,hour_local,location_id,net_sales_cents,orders_count")
    .eq("business_id",businessId).gte("business_date",period.from).lte("business_date",period.to)
    .order("business_date").order("hour_local").limit(1000);
   if(error)return missing("hourlySalesUnavailable");
   if(!data?.length)return missing("noHourlySalesFacts");
   return good({hours:data.map(r=>({date:r.business_date,hourLocal:r.hour_local,locationId:r.location_id,netSalesCents:Number(r.net_sales_cents),ordersCount:r.orders_count}))});
  },
  async employeeSales(period:CafeStatePeriod):Promise<KnownSlice<EmployeeSalesFacts>>{
   checkPeriod(period);
   const {data,error}=await db.from("employee_sales_rollup").select("business_date,employee_id,net_sales_cents,orders_count")
    .eq("business_id",businessId).gte("business_date",period.from).lte("business_date",period.to)
    .order("business_date").limit(1000);
   if(error)return missing("employeeSalesUnavailable");
   if(!data?.length)return missing("noEmployeeSalesFacts");
   return good({employees:data.map(r=>({date:r.business_date,employeeId:r.employee_id,netSalesCents:Number(r.net_sales_cents),ordersCount:r.orders_count}))});
  },
  async payrollFacts(period:CafeStatePeriod):Promise<KnownSlice<PayrollFacts>>{
   checkPeriod(period);
   const {data,error}=await db.from("employee_pay_period_facts").select("employee_id,pay_period_end,regular_cents,overtime_cents,double_overtime_cents,gross_cents,employee_tax_cents,employer_tax_cents,net_cents,source")
    .eq("business_id",businessId).gte("pay_period_end",period.from).lte("pay_period_end",period.to)
    .order("pay_period_end").limit(1000);
   if(error)return missing("payrollFactsUnavailable");
   if(!data?.length)return missing("noPayrollPeriodFacts");
   return good({payPeriods:data.map(r=>({employeeId:r.employee_id,payPeriodEnd:r.pay_period_end,regularCents:r.regular_cents==null?null:Number(r.regular_cents),overtimeCents:r.overtime_cents==null?null:Number(r.overtime_cents),doubleOvertimeCents:r.double_overtime_cents==null?null:Number(r.double_overtime_cents),grossCents:r.gross_cents==null?null:Number(r.gross_cents),employeeTaxCents:r.employee_tax_cents==null?null:Number(r.employee_tax_cents),employerTaxCents:r.employer_tax_cents==null?null:Number(r.employer_tax_cents),netCents:r.net_cents==null?null:Number(r.net_cents),source:r.source}))});
  }
 };
}
