import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
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
 const canonical=await db.from("orders").select("business_date")
  .eq("business_id",businessId).like("pos_order_id","toast:%")
  .in("business_date",possible).limit(1000);
 if(canonical.error||!Array.isArray(canonical.data)||canonical.data.length>=1000)
  throw new Error("Toast canonical source coverage unavailable");
 return new Set(canonical.data.map((row:{business_date:string})=>row.business_date));
}

/** Imported Toast days are visible even before external reconciliation. Missing
 * days are excluded; mismatches are visible with an explicit quality flag.
 * A failed status read is NOT proof that Toast sales are safe to report. */
export type ToastDayFlag={date:string;status:"imported"|"missing"|"failed";needsLook:boolean};
export async function toastDayFlags(
 db:SupabaseClient,businessId:string,from:string,to:string
):Promise<ToastDayFlag[]> {
 const {data,error}=await db.from("toast_day_status")
  .select("business_date,import_state,recon_state")
  .eq("business_id",businessId).gte("business_date",from).lte("business_date",to)
  .order("business_date").limit(373);
 if(error||!Array.isArray(data)||data.length>=373)
  throw new Error("Toast day status unavailable");
 return data.map(row=>({
  date:row.business_date,
  status:row.import_state as ToastDayFlag["status"],
  needsLook:["mismatch","owner_flagged"].includes(row.recon_state)
 }));
}
