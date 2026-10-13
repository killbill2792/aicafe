import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {recomputeDailyRollup} from "@/lib/pos/rollup";
import {ToastApiError} from "./client";
import {z} from "zod";
export const promoteSchema=z.object({
 businessId:z.uuid(),locationId:z.uuid(),restaurantGuid:z.uuid(),
 businessDate:z.iso.date(),checksum:z.string().regex(/^[a-f0-9]{64}$/),
 confirmPromotion:z.literal(true),
}).strict();
export async function promoteVerifiedToastDay(
 db:SupabaseClient,p:z.infer<typeof promoteSchema>) {
 const {data:count,error}=await db.rpc("toast_promote_reconciled_day",{
   p_business_id:p.businessId,p_location_id:p.locationId,
   p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,
   p_expected_sha256:p.checksum
 });
 if(error||!Number.isSafeInteger(count)) {
   // Do not leak source order IDs or sensitive DB constraints in owner-facing errors.
   throw new ToastApiError("invalid_response");
 }
 try {
   // Use existing canonical rollup, never another independent sales calculator.
   // No verified zero is promoted merely because an owner typed a matching zero report.
   await recomputeDailyRollup(db,p.businessId,p.businessDate);
   // Legacy rollup can return without surfacing its final upsert error.
   // Verify the canonical revenue aggregate before claiming that the write worked.
   const [{data:allOrders,error:ordersError},{data:rollup,error:rollupError}]=await Promise.all([
     db.from("orders").select("net_sales_cents").eq("business_id",p.businessId)
       .eq("business_date",p.businessDate),
     db.from("daily_rollups").select("net_sales_cents").eq("business_id",p.businessId)
       .eq("business_date",p.businessDate).maybeSingle(),
   ]);
   if(ordersError||rollupError||!rollup)throw new ToastApiError("unavailable");
   const sum=(allOrders??[]).reduce((total,row)=>total+Number(row.net_sales_cents),0);
   if(!Number.isSafeInteger(sum)||sum!==Number(rollup.net_sales_cents))
     throw new ToastApiError("unavailable");
 } catch {
   // Data transaction may have committed; remain retryable and do not pretend rollup refreshed.
   await db.from("toast_pilot_days").update({last_error_category:"rollup_unavailable"})
    .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
    .eq("business_date",p.businessDate);
   throw new ToastApiError("unavailable");
 }
 return {ordersPromoted:count,canonical:true,zeroDayVerified:false};
}
