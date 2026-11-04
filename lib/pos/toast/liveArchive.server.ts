import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {liveArchivePage} from "./liveArchive";

/** Saves today's finished orders from pages the live reading already
 * downloaded into the one-record-per-order archive (migration 149). Nothing is
 * downloaded again. A failure is logged by code only and never affects the
 * reading: the 5 AM import still saves every order. */
export async function archiveLiveToastOrders(admin:SupabaseClient,businessId:string,
 restaurantGuid:string,businessDate:string,pages:readonly (readonly unknown[])[]):Promise<number>{
 let saved=0;
 for(const rows of pages){
  const payload=liveArchivePage(rows);
  if(!payload.length)continue;
  const {data,error}=await admin.rpc("toast_archive_live_orders",{
   p_business_id:businessId,p_restaurant_guid:restaurantGuid,
   p_business_date:businessDate,p_payload:payload});
  if(error){
   console.warn("toast_live_archive_failed",{code:error.code??null});
   return saved;
  }
  saved+=typeof data==="number"?data:0;
 }
 return saved;
}
