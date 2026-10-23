/** Raj Cafe backfill plan. Dry-run by default; no production writes or credentials.
 * The production runner is intentionally not exposed. */
import type { SupabaseClient } from "@supabase/supabase-js";
export const rajCafeDates=Array.from({length:14},(_,i)=>new Date(Date.UTC(2026,7,22+i)).toISOString().slice(0,10));
export async function planRajCafeRollups(db:SupabaseClient,businessId:string) {
 const findings=[];
 for(const date of rajCafeDates) {
  const {data:orders,error}=await db.from("orders").select("net_sales_cents").eq("business_id",businessId).eq("business_date",date);
  if(error)throw error;
  findings.push({date,orderRows:orders?.length??0,netSalesCents:(orders??[]).reduce((a,o)=>a+Number(o.net_sales_cents),0),dryRun:true});
 }
 return findings;
}
// The operational recompute entry point is recomputeDailyRollup(db,businessId,date).
// Do not invoke it from this dry-run file.
