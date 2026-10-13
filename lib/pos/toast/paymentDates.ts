import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastClient,GUID,ToastApiError} from "./client";
export const paymentScanSchema=z.object({
 businessId:GUID,restaurantGuid:GUID,businessDate:z.iso.date()
}).strict();
/** Source-specific payment refund/void business dates, never invented from order close dates.
 * A payment GUID list is a review trigger, NOT a dollar settlement amount. */
export async function stageToastPaymentDateReview(db:SupabaseClient,
 p:z.infer<typeof paymentScanSchema>){
 if(p.businessDate>new Date().toISOString().slice(0,10))
   throw new ToastApiError("invalid_response");
 const client=createToastClient(db,p.businessId);
 const day=p.businessDate.replaceAll("-","");
 const results:{kind:"refunded"|"voided";count:number}[]=[];
 for(const [kind,queryKey] of [
  ["refunded","refundBusinessDate"],["voided","voidBusinessDate"]
 ] as const){
   const rows=await client.request("/orders/v2/payments?"+queryKey+"="+day,
     p.restaurantGuid,z.array(GUID).max(2000));
   // One provider response is completely validated before atomic SQL stage.
   const {error}=await db.rpc("toast_stage_payment_day_events",{
    p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
    p_date:p.businessDate,p_kind:kind,p_guids:[...new Set(rows)]
   });
   if(error)throw new ToastApiError("unavailable");
   results.push({kind,count:rows.length});
 }
 return {date:p.businessDate,results,verifiedZero:false,
   refundAmountsVerified:false,settlementAmountsVerified:false,
   financialReportingVerified:false,independentReportVerified:false,
   requiresReview:results.some(r=>r.count>0)};
}
