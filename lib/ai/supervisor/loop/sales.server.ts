import "server-only";
import {formatInTimeZone} from "date-fns-tz";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {aggregatePriceExperimentSalesRows,type PriceExperimentDay} from "@/lib/calc/priceExperiment";
import {utcDateOffset} from "./engine";

/** Read strictly completed business dates and exact canonical POS source coverage.
 * A missing/late rollup, an invalid line or a truncated PostgREST page NEVER
 * becomes a zero-sales day.
 */
export async function readPriceExperimentSalesDays(
 businessId:string,productId:string,firstDate:string,days:number
):Promise<PriceExperimentDay[]>{
 if(!Number.isSafeInteger(days)||days<1||days>31)throw new Error("invalid_sales_window");
 const lastDate=utcDateOffset(firstDate,days-1);
 const db=createAdminSupabaseClient();
 const [coverage,orders]=await Promise.all([
   db.from("daily_rollups").select("business_date,sales_data_status")
     .eq("business_id",businessId).gte("business_date",firstDate)
     .lte("business_date",lastDate).limit(32),
   db.from("order_lines")
     .select("quantity,net_sales_cents,orders!inner(business_date,business_id)",{count:"exact"})
     .eq("menu_item_id",productId).eq("orders.business_id",businessId)
     .gte("orders.business_date",firstDate).lte("orders.business_date",lastDate)
     .eq("voided",false).limit(10000),
 ]);
 if(coverage.error||orders.error)throw new Error("canonical_sales_reader_unavailable");
 const pageComplete=orders.count!==null&&orders.count===(orders.data?.length??0);
 // Fail closed if any scope row is malformed: complete coverage without a
 // complete underlying order page is not actual evidence of zero sales.
 const rowsByDay=new Map<string,Array<{quantity:number;netSalesCents:number}>>();
 let invalid=!pageComplete;
 if(pageComplete)for(const line of orders.data??[]){
   const record=Array.isArray(line.orders)?line.orders[0]:line.orders;
   const day=record?.business_date;
   if(typeof day!=="string"||day<firstDate||day>lastDate||
      !Number.isSafeInteger(line.quantity)||line.quantity<0||
      !Number.isSafeInteger(line.net_sales_cents)||line.net_sales_cents<0){
     invalid=true;break;
   }
   const rows=rowsByDay.get(day)??[];
   rows.push({quantity:line.quantity,netSalesCents:line.net_sales_cents});
   rowsByDay.set(day,rows);
 }
 const rollups=new Map<string,string>();
 for(const row of coverage.data??[]){
   if(rollups.has(row.business_date))invalid=true;
   rollups.set(row.business_date,row.sales_data_status);
 }
 return Array.from({length:days},(_,i)=>{
   const businessDate=utcDateOffset(firstDate,i);
   const total=!invalid&&rollups.get(businessDate)==="actual"?
     aggregatePriceExperimentSalesRows(rowsByDay.get(businessDate)??[]):null;
   return total?{businessDate,units:total.units,netSalesCents:total.netSalesCents,
     coverage:"actual" as const,source:"daily_rollups+order_lines"}:null;
 }).filter((day):day is NonNullable<typeof day>=>day!==null);
}
/** Seven completed calendar days in the café's timezone; never include a
 * partially synchronized current business day in the baseline forecast.
 */
export async function readPriceExperimentBaselineUnits(
 businessId:string,productId:string
):Promise<number|null>{
 const db=createAdminSupabaseClient();
 const {data,error}=await db.from("businesses").select("timezone")
   .eq("id",businessId).single();
 if(error||!data)return null;
 const today=formatInTimeZone(new Date(),data.timezone||"America/Los_Angeles","yyyy-MM-dd");
 const start=utcDateOffset(today,-7);
 const days=await readPriceExperimentSalesDays(businessId,productId,start,7);
 if(days.length!==7||days.some(d=>d.coverage!=="actual"))return null;
 const sums=aggregatePriceExperimentSalesRows(days.map(d=>({
   quantity:d.units,netSalesCents:d.netSalesCents})));
 return sums?.units??null;
}
