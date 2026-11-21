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

/** Date-only bounds of stored actual sales, not proof of financial completeness.
 * The caller verifies a selected day with the ordinary shared reader. */
export async function readSalesCoverageBounds(db:SupabaseClient,businessId:string,from:string,to:string):Promise<{from:string;to:string}|null>{
 if(!businessId||from>to)throw new Error("Invalid sales coverage scope");
 const read=async(ascending:boolean)=>{
  const {data,error}=await db.from("daily_rollups").select("business_date")
   .eq("business_id",businessId).eq("sales_data_status","actual")
   .gte("business_date",from).lte("business_date",to)
   .order("business_date",{ascending}).range(0,0);
  if(error||!Array.isArray(data)||data.length>1)throw new Error("Sales coverage unavailable");
  if(!data.length)return null;
  const date=data[0].business_date;
  if(typeof date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<from||date>to)
   throw new Error("Invalid sales coverage date");
  return date;
 };
 const [first,last]=await Promise.all([read(true),read(false)]);
 if(first===null&&last===null)return null;
 if(first===null||last===null||first>last)throw new Error("Sales coverage changed during read");
 return {from:first,to:last};
}
