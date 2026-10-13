import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAdapter} from "./adapter";
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
export async function stageQueuedToastOrder(db:SupabaseClient,event:Claimed) {
 const {data:mapping,error:mapError}=await db.from("toast_location_mappings")
   .select("verified_at").eq("business_id",event.business_id)
   .eq("restaurant_guid",event.restaurant_guid).maybeSingle();
 if(mapError||!mapping?.verified_at)throw new ToastApiError("unauthorized_location");
 // Freshest Toast order read; never persist the webhook's unfiltered guest payload.
 const adapter=createToastAdapter({
  db,businessId:event.business_id,restaurantGuid:event.restaurant_guid
 });
 const fact=await adapter.fetchOrderStateByGuid(event.order_guid);
 const {error:writeError}=await db.rpc("toast_store_order_fact",{
   p_business_id:event.business_id,p_restaurant_guid:event.restaurant_guid,
   p_order_guid:fact.orderGuid,p_modified_at:fact.modifiedAt,
   p_state:fact.state,p_normalized_order:fact.normalizedOrder,
   p_event_guid:event.event_guid,
 });
 if(writeError)throw new ToastApiError("unavailable");
 const {error:healthError}=await db.from("toast_sync_health").upsert({
  business_id:event.business_id,restaurant_guid:event.restaurant_guid,
  last_attempt_at:new Date().toISOString(),last_order_fetch_at:new Date().toISOString(),
  last_failure_category:null
 },{onConflict:"business_id,restaurant_guid"});
 if(healthError)throw new ToastApiError("unavailable");
 return fact.state==="completed"?"completed":"review_required";
}
export async function runToastOrderQueue(db:SupabaseClient) {
 const {data:claimed,error:claimError}=await db.rpc("toast_claim_order_events",{p_limit:2});
 if(claimError)throw new ToastApiError("unavailable");
 const events=claimed as Claimed[]|null;
 let staged=0,failed=0,review=0;
 for(const event of events??[]){
   let failure:string|null=null,retryAt:string|null=null;
   try {
     const state=await stageQueuedToastOrder(db,event);
     staged++;if(state==="review_required")review++;
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
