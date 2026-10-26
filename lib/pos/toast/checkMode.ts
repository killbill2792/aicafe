import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAnalyticsClient} from "./analyticsClient";
import {ToastApiError} from "./client";
import {addCalendarDays,localClock} from "./scheduleDates";
export type CheckMode="official"|"internal";
export type ModeReason="no_analytics_credentials"|"analytics_forbidden"|"analytics_auth_failed"|"analytics_timeout"|"ok";
export async function setToastCheckMode(db:SupabaseClient,businessId:string,mode:CheckMode,
 reason:ModeReason,usedVerifiedAt:string|null=null):Promise<boolean>{
 if(mode==="official"){
  const {data:enabled,error}=await db.rpc("toast_enable_official_check",{p_business_id:businessId});
  if(error||enabled!==true)throw new ToastApiError("unavailable");
  return true;
  // toast_enable_official_check atomically promotes mode, drops suspended
  // reports and queues fresh per-day work for all of this business's locations.
 }
 if(mode==="internal"){
  const {data:disabled,error}=await db.rpc("toast_disable_official_check",{
   p_business_id:businessId,p_reason:reason,p_expected_verified_at:usedVerifiedAt
  });
  if(error)throw new ToastApiError("unavailable");
  return disabled===true;
 }
 return false;
}
/** Only separate Analytics credentials ever reach ERA. Login alone proves nothing. */
export async function detectToastCheckMode(db:SupabaseClient,businessId:string,
 restaurantGuid:string,zone:string,deadlineAt:number,force=false):Promise<CheckMode>{
 const {data:cred,error}=await db.from("toast_analytics_credentials").select("business_id,verified_at")
  .eq("business_id",businessId).maybeSingle();
 if(error)throw new ToastApiError("unavailable");
 // Capture BEFORE the asynchronous probe; a re-verified credential has a
 // different generation and must survive this provider request's failure.
 const usedVerification=cred?.verified_at??null;
 if(!cred){await setToastCheckMode(db,businessId,"internal","no_analytics_credentials");return "internal";}
 const {data:mode,error:me}=await db.from("toast_api_credentials")
  .select("toast_check_mode,mode_checked_at").eq("business_id",businessId).single();
 if(me)throw new ToastApiError("unavailable");
 if(!force&&mode.mode_checked_at&&Date.parse(mode.mode_checked_at)>Date.now()-7*86400000)
  return mode.toast_check_mode as CheckMode;
 try{
  await createToastAnalyticsClient(db,businessId,deadlineAt).test(restaurantGuid,
   addCalendarDays(localClock(new Date(),zone).today,-2));
  await setToastCheckMode(db,businessId,"official","ok");return "official";
 }catch(e){
  let downgraded=false;
  if(e instanceof ToastApiError&&["authentication","missing_permissions"].includes(e.category)){
   downgraded=await setToastCheckMode(db,businessId,"internal",
    e.category==="authentication"?"analytics_auth_failed":"analytics_forbidden",usedVerification);
  }
  if(force)throw e;
  // Transient provider failure never stops the internal check or changes a proven mode.
  return e instanceof ToastApiError&&["authentication","missing_permissions"].includes(e.category)
   &&downgraded?"internal":mode.toast_check_mode as CheckMode;
 }
}
