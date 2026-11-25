import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fetchAndIngestToastOrder} from "./orderIngestion";
import {ToastApiError} from "./client";
type Claimed={
 business_id:string;restaurant_guid:string;event_guid:string;order_guid:string;
 attempts:number;lease_nonce:string;
};
export function orderEventRetryAt(error:unknown,attempts:number,now=Date.now()):string {
 if(error instanceof ToastApiError&&error.retryAt&&Date.parse(error.retryAt)>now)
   return error.retryAt;
 // Bounded exponential retry; each failed job is a durable state, not a hot loop.
 return new Date(now+Math.min(60*60*1000,Math.pow(2,Math.min(attempts,8))*15000)).toISOString();
}
export async function stageQueuedToastOrder(db:SupabaseClient,event:Claimed,deadlineAt?:number) {
 const {data:mapping,error:mapError}=await db.from("toast_location_mappings")
   .select("verified_at,toast_time_zone,closeout_hour").eq("business_id",event.business_id)
   .eq("restaurant_guid",event.restaurant_guid).maybeSingle();
 if(mapError||!mapping?.verified_at||!mapping.toast_time_zone||mapping.closeout_hour==null)
  throw new ToastApiError("unauthorized_location");
 const result=await fetchAndIngestToastOrder(db,{businessId:event.business_id,restaurantGuid:event.restaurant_guid,
  timezone:mapping.toast_time_zone,closeoutHour:mapping.closeout_hour},event.order_guid,deadlineAt);
 // Publish the shared summary immediately when the location has a complete seed.
 const {error:summaryError}=await db.rpc("toast_refresh_canonical_live",{p_business_id:event.business_id});
 if(summaryError)throw new ToastApiError("unavailable");
 return result;
}
export async function runToastOrderQueue(db:SupabaseClient,deadlineAt?:number) {
 const {data:claimed,error:claimError}=await db.rpc("toast_claim_order_events",{p_limit:2});
 if(claimError)throw new ToastApiError("unavailable");
 const events=claimed as Claimed[]|null;
 let staged=0,failed=0,review=0;
 for(const event of events??[]){
   let failure:string|null=null,retryAt:string|null=null;
   try {
     const state=await stageQueuedToastOrder(db,event,deadlineAt);
     staged++;if(state==="repair_queued")review++;
   }catch(error){
     failed++;
     failure=error instanceof ToastApiError?error.category:"unavailable";
     retryAt=orderEventRetryAt(error,event.attempts);
   }
   const {data:completed,error:finishError}=await db.rpc("toast_finish_order_event",{
     p_business_id:event.business_id,p_event_guid:event.event_guid,
     p_lease_nonce:event.lease_nonce,p_success:failure===null,
     p_retry_after:retryAt,p_failure_category:failure
   });
   if(finishError||!completed)throw new ToastApiError("unavailable");
 }
 return {claimed:events?.length??0,staged,failed,needsReview:review};
}
