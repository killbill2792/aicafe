import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {canonicalViewNames,type CanonicalView} from "./dictionary";

export type CanonicalRange={dateFrom:string;dateTo:string};
export type CanonicalRow=Record<string,unknown>;
export type CanonicalRead={rows:CanonicalRow[];notes:string[];empty:boolean;
 truncated:boolean;rowCount:number;error?:string};
const bounded=z.object({dateFrom:z.iso.date(),dateTo:z.iso.date()});
const periodViews=new Set<CanonicalView>([
 "cv_sales_days","cv_sales_hours","cv_item_sales","cv_payments","cv_discounts",
 "cv_voids_refunds","cv_card_fees","cv_analytics"
]);
/** The only canonical view query path for screens and AI.
 * Never accept an arbitrary SQL table or inferred café ID from the model. */
export async function readCanonicalView(db:SupabaseClient,businessId:string,
 view:CanonicalView,range:CanonicalRange,requestedLimit=200):Promise<CanonicalRead>{
 if(!z.uuid().safeParse(businessId).success||
   !canonicalViewNames.includes(view))
  return {rows:[],notes:["invalid_scope"],empty:true,truncated:false,rowCount:0,error:"invalid_scope"};
 const parsed=bounded.safeParse(range);
 if(!parsed.success||range.dateFrom>range.dateTo)
  return {rows:[],notes:["invalid_date_range"],empty:true,truncated:false,rowCount:0,error:"invalid_range"};
 const limit=Math.min(1000,Math.max(1,Math.floor(requestedLimit)));
 let query=db.from(view).select("*").eq("business_id",businessId);
 if(periodViews.has(view))
  query=query.gte("business_date",range.dateFrom).lte("business_date",range.dateTo);
 const {data,error}=await query.order("source_ref").limit(limit+1);
 if(error)return {rows:[],notes:["source_read_failed"],empty:true,truncated:false,
  rowCount:0,error:"source_read_failed"};
 const rows=(data??[]) as CanonicalRow[],truncated=rows.length>limit;
 const selected=rows.slice(0,limit);
 return {rows:selected,notes:[...(selected.length===0?["no_matching_rows"]:[]),
  ...(truncated?["result_truncated"]:[])],empty:selected.length===0,
  truncated,rowCount:selected.length};
}
const wrap=(view:CanonicalView)=>(db:SupabaseClient,businessId:string,
 range:CanonicalRange)=>readCanonicalView(db,businessId,view,range);
export const readSalesDays=wrap("cv_sales_days");
export const readSalesHours=wrap("cv_sales_hours");
export const readItemSales=wrap("cv_item_sales");
export const readPayments=wrap("cv_payments");
export const readDiscounts=wrap("cv_discounts");
export const readVoidsRefunds=wrap("cv_voids_refunds");
export const readCardFees=wrap("cv_card_fees");
export const readLaborEntries=wrap("cv_labor_entries");
export const readStaff=wrap("cv_staff");
export const readShifts=wrap("cv_shifts");
export const readMenu=wrap("cv_menu");
export const readBills=wrap("cv_bills");
export const readInventory=wrap("cv_inventory");
export const readOwnerFacts=wrap("cv_owner_facts");
export const readAnalytics=wrap("cv_analytics");
