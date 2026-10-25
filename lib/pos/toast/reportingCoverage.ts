import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readAllPages} from "./readAllPages";
/** The legacy reporting guard can only remove an AGGREGATE daily rollup when
 * canonical Toast orders may contaminate it. A staged-only pilot day or a refund
 * GUID on the same date never invalidates independently verified Square/CSV sales.
 * A mixed Toast+Square/CSV rollup cannot be split without changing source-specific
 * accounting; exclude that aggregate and report missing verification instead.
 * Fail closed on unavailable/truncated source coverage. */
export async function unverifiedToastSalesDates(
 db:SupabaseClient,businessId:string,from:string,to:string
):Promise<Set<string>> {
 const {data,error}=await db.rpc("toast_unverified_sales_dates",{
  p_business_id:businessId,p_from:from,p_to:to
 });
 if(error||!Array.isArray(data))throw new Error("Toast sales coverage unavailable");
 const possible=[...new Set(data.map((row:{business_date:string})=>row.business_date))];
 if(!possible.length)return new Set();
 if(possible.length>371)throw new Error("Toast coverage range exceeds bounds");
 // The RPC includes pilot-only and payment-review dates for audit. Those dates
 // must not hide proven Square/CSV canonical revenue when no Toast sale was imported.
 const canonical=await readAllPages((start,end)=>db.from("orders")
  .select("id,business_date")
  .eq("business_id",businessId).like("pos_order_id","toast:%")
  .in("business_date",possible).order("id").range(start,end));
 return new Set(canonical.map(row=>row.business_date));
}

/** Imported Toast days are visible even before external reconciliation. Missing
 * days are excluded; mismatches are visible with an explicit quality flag.
 * A failed status read is NOT proof that Toast sales are safe to report. */
export type ToastDayFlag={date:string;status:"imported"|"missing"|"failed";needsLook:boolean};
export async function toastDayFlags(
 db:SupabaseClient,businessId:string,from:string,to:string
):Promise<ToastDayFlag[]> {
 const data=await readAllPages((start,end)=>db.from("toast_day_status")
  .select("business_date,restaurant_guid,import_state,recon_state,last_error_category")
  .eq("business_id",businessId).gte("business_date",from).lte("business_date",to)
  .order("business_date").order("restaurant_guid").range(start,end));
 const flags=await readAllPages((start,end)=>db.rpc("toast_attention_days",{
  p_business_id:businessId,p_from:from,p_to:to
 }).range(start,end));
 const flagged=new Set(flags.map(x=>x.business_date));
 return data.map(row=>({
  date:row.business_date,
  status:row.import_state as ToastDayFlag["status"],
  needsLook:flagged.has(row.business_date)
 }));
}
