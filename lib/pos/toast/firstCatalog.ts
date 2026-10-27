import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {localClock} from "./scheduleDates";
import {copyToastPublishedMenu,recordToastCopyFailure} from "./operationalCopy";
import {ToastApiError} from "./client";

type Scope={business_id:string;restaurant_guid:string;location_id:string;toast_time_zone:string};
/** On a café's first automatic sync, catalog import must precede any sales day.
 * Once successful, the stamp prevents this preflight from stealing backfill time
 * on every tick. The ordinary daily/modified catalog phase still runs later. */
export async function syncToastFirstCatalogIfMissing(
 db:SupabaseClient,location:Scope,now:Date,deadlineAt:number):Promise<boolean>{
 if(Date.now()>=deadlineAt)return false;
 const key={business_id:location.business_id,restaurant_guid:location.restaurant_guid};
 const {data:stamp,error:stampError}=await db.from("toast_optional_sync_state")
  .select("menu_checked_local_day").eq("business_id",key.business_id)
  .eq("restaurant_guid",key.restaurant_guid).maybeSingle();
 if(stampError)throw new ToastApiError("unavailable");
 if(stamp?.menu_checked_local_day)return false;
 const {data:credentials,error:credentialError}=await db.from("toast_api_credentials")
  .select("scopes_available").eq("business_id",key.business_id).maybeSingle();
 if(credentialError)throw new ToastApiError("unavailable");
 if(credentials?.scopes_available?.menus===false)return false;
 const scope={businessId:key.business_id,restaurantGuid:key.restaurant_guid,
  locationId:location.location_id,timezone:location.toast_time_zone,deadlineAt};
 try{
  await copyToastPublishedMenu(db,scope);
  const {error:writeError}=await db.from("toast_optional_sync_state").upsert({
   ...key,menu_checked_local_day:localClock(now,location.toast_time_zone).today
  },{onConflict:"business_id,restaurant_guid"});
  if(writeError)throw writeError;
  return true;
 }catch(error){
  try{await recordToastCopyFailure(db,scope,"menu",error);}
  catch{ /* The cron phase-error record still tracks this failed attempt. */ }
  throw error;
 }
}
