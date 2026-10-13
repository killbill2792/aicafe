import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
/** A staged Toast day is NOT proof of complete revenue, including a $0 day.
 * Never call this for unauthenticated users or infer verified from an empty result.
 * Call only when the explicit Toast pilot flag is on: existing Square-only reports
 * are untouched when no Toast pilot exists. */
export async function unverifiedToastSalesDates(
 db:SupabaseClient,businessId:string,from:string,to:string
):Promise<Set<string>> {
 const {data,error}=await db.rpc("toast_unverified_sales_dates",{
  p_business_id:businessId,p_from:from,p_to:to,
 });
 if(error||!Array.isArray(data))throw new Error("Toast sales coverage unavailable");
 return new Set(data.map((row:{business_date:string})=>row.business_date));
}
