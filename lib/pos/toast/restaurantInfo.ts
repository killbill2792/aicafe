import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastClient,ToastApiError} from "./client";
import {openSourceStream} from "@/lib/externalData/archive.server";

export async function refreshToastRestaurantInfo(
 db:SupabaseClient,businessId:string,restaurantGuid:string,
 options:{allowUnverified?:boolean;deadlineAt?:number}={}
){
 const client=createToastClient(db,businessId);
 const info=await client.fetchRestaurantInfo(restaurantGuid,Boolean(options.allowUnverified),options.deadlineAt);
 if(info.guid.toLowerCase()!==restaurantGuid.toLowerCase())
  throw new ToastApiError("unauthorized_location");
 const archive=await openSourceStream(db,{businessId,provider:"toast",account:restaurantGuid},
  "restaurants/v1/restaurants/{restaurantGUID}","current");
 await archive.commit([{key:restaurantGuid,payload:info}],null,true);
 const {error}=await db.from("toast_location_mappings").update({
  toast_time_zone:info.general.timeZone,closeout_hour:info.general.closeoutHour,
  info_refreshed_at:new Date().toISOString()
 }).eq("business_id",businessId).eq("restaurant_guid",restaurantGuid);
 if(error)throw new ToastApiError("unavailable");
 return info;
}
