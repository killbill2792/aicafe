import type {SupabaseClient} from "@supabase/supabase-js";
import type {DailyFacts} from "@/lib/calc";
import {rowToDailyFacts} from "./runningCostCatalog";

/** The ONE reader of saved daily totals (sales, orders, ingredient cost, labor,
 * fees, voids). Every screen and every chat tool reads days through here, so
 * the same day can never show two different numbers. Writers live in
 * lib/pos/rollup.ts and the Toast import. */
export const DAILY_FACT_COLUMNS="business_date,net_sales_cents,orders_count,drinks_count,ingredients_cents,"+
 "staff_wages_cents,staff_tax_cents,labor_wage_status,staff_tax_status,staff_tax_source,sales_data_status,"+
 "card_fees_cents,card_fees_status,voids_cents";
export type DailyFactRow=Parameters<typeof rowToDailyFacts>[0];
const PAGE=1000;

/** Every saved day in [from, to], oldest first, all pages. */
export async function readDailyFactRows(db:SupabaseClient,businessId:string,from:string,to:string):Promise<DailyFactRow[]>{
 const rows:DailyFactRow[]=[];
 for(let offset=0;;offset+=PAGE){
  const {data,error}=await db.from("daily_rollups").select(DAILY_FACT_COLUMNS)
   .eq("business_id",businessId).gte("business_date",from).lte("business_date",to)
   .order("business_date",{ascending:true}).range(offset,offset+PAGE-1);
  if(error)throw error;
  const page=(data??[]) as unknown as DailyFactRow[];
  rows.push(...page);
  if(page.length<PAGE)return rows;
 }
}
export async function readDailyFacts(db:SupabaseClient,businessId:string,from:string,to:string):Promise<DailyFacts[]>{
 return (await readDailyFactRows(db,businessId,from,to)).map(rowToDailyFacts);
}
/** Days whose sales are complete and can be reported. */
export async function readCoveredSalesDates(db:SupabaseClient,businessId:string,from:string,to:string):Promise<string[]>{
 return (await readDailyFactRows(db,businessId,from,to))
  .filter(row=>row.sales_data_status==="actual").map(row=>row.business_date);
}
