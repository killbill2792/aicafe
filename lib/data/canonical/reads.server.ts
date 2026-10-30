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
 "cv_voids_refunds","cv_card_fees","cv_analytics","cv_labor_entries",
 "cv_shifts","cv_inventory","cv_orders","cv_cash","cv_kitchen","cv_dining_options"
]);
/** The only canonical view query path for screens and AI.
 * Never accept an arbitrary SQL table or inferred café ID from the model. */
/** Row statuses a caller may filter on before the limit (open, actual, needs_match...). */
const statusFilter=z.enum(["open","actual","estimated","needs_match"]);
export async function readCanonicalView(db:SupabaseClient,businessId:string,
 view:CanonicalView,range:CanonicalRange,requestedLimit=200,
 filter:{status?:z.infer<typeof statusFilter>}={}):Promise<CanonicalRead>{
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
 if(filter.status!==undefined){
  if(!statusFilter.safeParse(filter.status).success)
   return {rows:[],notes:["invalid_scope"],empty:true,truncated:false,rowCount:0,error:"invalid_scope"};
  query=query.eq("status",filter.status);
 }
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
/** Finished shifts with no hourly wage, filtered before the limit. */
export const readLaborEntriesMissingWage=(db:SupabaseClient,businessId:string,
 range:CanonicalRange,limit=20)=>readCanonicalView(db,businessId,"cv_labor_entries",range,limit,{status:"needs_match"});
export const readStaff=wrap("cv_staff");
export const readShifts=wrap("cv_shifts");
export const readMenu=wrap("cv_menu");
export const readBills=wrap("cv_bills");
export const readInventory=wrap("cv_inventory");
export const readOwnerFacts=wrap("cv_owner_facts");
export const readAnalytics=wrap("cv_analytics");
export const readOrders=wrap("cv_orders");
export const readCash=wrap("cv_cash");
export const readKitchen=wrap("cv_kitchen");
export const readDiningOptions=wrap("cv_dining_options");
