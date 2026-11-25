import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fetchAndIngestToastOrder} from "./orderIngestion";
import {ToastApiError} from "./client";
import type {ToastWebhookKind} from "./webhookSignature";
type Claimed={
 business_id:string;restaurant_guid:string;event_guid:string;order_guid:string|null;event_kind:ToastWebhookKind;event_version:string|null;item_guid:string|null;event_time:string;
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
   .select("verified_at,toast_time_zone,closeout_hour,location_id").eq("business_id",event.business_id)
   .eq("restaurant_guid",event.restaurant_guid).maybeSingle();
 if(mapError||!mapping?.verified_at||!mapping.toast_time_zone||mapping.closeout_hour==null)
  throw new ToastApiError("unauthorized_location");
 if(!event.order_guid)throw new ToastApiError("invalid_response");
 const result=await fetchAndIngestToastOrder(db,{businessId:event.business_id,restaurantGuid:event.restaurant_guid,
  timezone:mapping.toast_time_zone,closeoutHour:mapping.closeout_hour},event.order_guid,deadlineAt);
 // Publish the shared summary immediately when the location has a complete seed.
 const {error:summaryError}=await db.rpc("toast_refresh_canonical_live",{p_business_id:event.business_id});
 if(summaryError)throw new ToastApiError("unavailable");
 return result;
}
export async function runToastOrderQueue(db:SupabaseClient,deadlineAt?:number) {
 const {data:claimed,error:claimError}=await db.rpc("toast_claim_provider_events",{p_limit:2});
 if(claimError)throw new ToastApiError("unavailable");
 const events=claimed as Claimed[]|null;
 let staged=0,failed=0;
 for(const event of events??[]){
   let failure:string|null=null,retryAt:string|null=null;
   try {
     if(event.event_kind==="orders")await stageQueuedToastOrder(db,event,deadlineAt);
     else await refreshQueuedOperationalEvent(db,event,deadlineAt);
     staged++;
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
 return {claimed:events?.length??0,staged,failed,needsReview:0};
}

async function refreshQueuedOperationalEvent(db:SupabaseClient,event:Claimed,deadlineAt=Date.now()+20000){
 const {data:m,error}=await db.from("toast_location_mappings").select("verified_at,toast_time_zone,closeout_hour,location_id")
  .eq("business_id",event.business_id).eq("restaurant_guid",event.restaurant_guid).maybeSingle();
 if(error||!m?.verified_at||!m.toast_time_zone||m.closeout_hour==null)throw new ToastApiError("unauthorized_location");
 const {data:nonce,error:claim}=await db.rpc("toast_acquire_lease",{p_business_id:event.business_id,p_restaurant_guid:event.restaurant_guid,p_seconds:241});
 if(claim||!nonce)throw new ToastApiError("unavailable");
 try{
  if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
  if(event.event_kind==="menus"){
   const {syncToastOptionalSources}=await import("./optionalSync");
   const result=await syncToastOptionalSources(db,{business_id:event.business_id,restaurant_guid:event.restaurant_guid,
    location_id:m.location_id,toast_time_zone:m.toast_time_zone,closeout_hour:m.closeout_hour},new Date(),deadlineAt,"menu");
   if(!("version" in result)||!result.version||!event.event_version||Date.parse(result.version)<Date.parse(event.event_version))
    throw new ToastApiError("unavailable");
  }else if(event.event_kind==="stock"||event.event_kind==="availability"||event.event_kind==="ordering"){
   const {refreshToastOperationalEvent}=await import("./operationalCopy");
   await refreshToastOperationalEvent(db,{businessId:event.business_id,restaurantGuid:event.restaurant_guid,
    locationId:m.location_id,timezone:m.toast_time_zone,closeoutHour:m.closeout_hour},event.event_kind,event.item_guid,event.event_time,deadlineAt);
  }else throw new ToastApiError("invalid_response");
 }finally{await db.rpc("toast_release_lease",{p_nonce:nonce});}
}
