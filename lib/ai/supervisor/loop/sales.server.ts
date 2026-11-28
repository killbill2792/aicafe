import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {formatInTimeZone} from "date-fns-tz";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {aggregatePriceExperimentSalesRows,type PriceExperimentDay} from "@/lib/calc/priceExperiment";
import {utcDateOffset} from "./engine";
import {readDailyFactRows} from "@/lib/data/dailyFacts.server";

/** Read strictly completed business dates and exact canonical POS source coverage.
 * A missing/late rollup, an invalid line or a truncated PostgREST page NEVER
 * becomes a zero-sales day.
 */
export async function readPriceExperimentSalesDays(
 businessId:string,productId:string,firstDate:string,days:number,scopedClient?:SupabaseClient
):Promise<PriceExperimentDay[]>{
 if(!Number.isSafeInteger(days)||days<1||days>31)throw new Error("invalid_sales_window");
 const lastDate=utcDateOffset(firstDate,days-1);
 const db=scopedClient??createAdminSupabaseClient();
 const [coverage,orders]=await Promise.all([
   readDailyFactRows(db,businessId,firstDate,lastDate)
     .then(data=>({data,error:null}),error=>({data:null,error})),
   db.from("cv_item_sales")
     .select("quantity,net_sales_cents,business_date",{count:"exact"})
     .eq("menu_item_id",productId).eq("business_id",businessId).eq("status","actual")
     .gte("business_date",firstDate).lte("business_date",lastDate).limit(10000),
 ]);
 if(coverage.error||orders.error)throw new Error("canonical_sales_reader_unavailable");
 const pageComplete=orders.count!==null&&orders.count===(orders.data?.length??0);
 // Fail closed if any scope row is malformed: complete coverage without a
 // complete underlying order page is not actual evidence of zero sales.
 const rowsByDay=new Map<string,Array<{quantity:number;netSalesCents:number}>>();
 let invalid=!pageComplete;
 if(pageComplete)for(const line of orders.data??[]){
   const day=line.business_date;
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
   rollups.set(row.business_date,row.sales_data_status??"missing");
 }
 return Array.from({length:days},(_,i)=>{
   const businessDate=utcDateOffset(firstDate,i);
   const total=!invalid&&rollups.get(businessDate)==="actual"?
     aggregatePriceExperimentSalesRows(rowsByDay.get(businessDate)??[]):null;
   return total?{businessDate,units:total.units,netSalesCents:total.netSalesCents,
     coverage:"actual" as const,source:"daily_rollups+cv_item_sales"}:null;
 }).filter((day):day is NonNullable<typeof day>=>day!==null);
}
/** Seven completed calendar days in the café's timezone; never include a
 * partially synchronized current business day in the baseline forecast.
 */
export async function readPriceExperimentBaselineUnits(
 businessId:string,productId:string,scopedClient?:SupabaseClient
):Promise<number|null>{
 const db=scopedClient??createAdminSupabaseClient();
 const {data,error}=await db.from("businesses").select("timezone")
   .eq("id",businessId).single();
 if(error||!data)return null;
 const today=formatInTimeZone(new Date(),data.timezone||"America/Los_Angeles","yyyy-MM-dd");
 const start=utcDateOffset(today,-7);
 const days=await readPriceExperimentSalesDays(businessId,productId,start,7,db);
 if(days.length!==7||days.some(d=>d.coverage!=="actual"))return null;
 const sums=aggregatePriceExperimentSalesRows(days.map(d=>({
   quantity:d.units,netSalesCents:d.netSalesCents})));
 return sums?.units??null;
}
