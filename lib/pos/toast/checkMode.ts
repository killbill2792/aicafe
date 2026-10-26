import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAnalyticsClient} from "./analyticsClient";
import {ToastApiError} from "./client";
import {addCalendarDays,localClock} from "./scheduleDates";
export type CheckMode="official"|"internal";
export type ModeReason="no_analytics_credentials"|"analytics_forbidden"|"analytics_auth_failed"|"analytics_timeout"|"ok";
export async function setToastCheckMode(db:SupabaseClient,businessId:string,mode:CheckMode,reason:ModeReason){
 if(mode==="official"){
  const {data:enabled,error}=await db.rpc("toast_enable_official_check",{p_business_id:businessId});
  if(error||enabled!==true)throw new ToastApiError("unavailable");
  const {error:queue}=await db.from("toast_day_status").update({analytics_state:"pending",last_recon_attempt_at:null})
   .eq("business_id",businessId).eq("recon_state","checked_internal").is("analytics_state",null);
  if(queue)throw new ToastApiError("unavailable");
  // A previous 48-hour timeout/permissions downgrade must not strand days
  // when Analytics becomes usable again. Re-probe only incomplete ERA work.
  const {error:resume}=await db.from("toast_day_status")
   .update({analytics_state:"pending",last_recon_attempt_at:null})
   .eq("business_id",businessId).eq("import_state","imported")
   .eq("analytics_state","missing");
  if(resume)throw new ToastApiError("unavailable");
 }
 if(mode==="internal"){
  const {error}=await db.from("toast_api_credentials").update({toast_check_mode:"internal",
   mode_reason:reason,mode_checked_at:new Date().toISOString()}).eq("business_id",businessId);
  if(error)throw new ToastApiError("unavailable");
  const {error:clear}=await db.from("toast_analytics_credentials").update({verified_at:null})
   .eq("business_id",businessId);
  if(clear)throw new ToastApiError("unavailable");
 }
}
/** Only separate Analytics credentials ever reach ERA. Login alone proves nothing. */
export async function detectToastCheckMode(db:SupabaseClient,businessId:string,
 restaurantGuid:string,zone:string,deadlineAt:number,force=false):Promise<CheckMode>{
 const {data:cred,error}=await db.from("toast_analytics_credentials").select("business_id")
  .eq("business_id",businessId).maybeSingle();
 if(error)throw new ToastApiError("unavailable");
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
  if(e instanceof ToastApiError&&["authentication","missing_permissions"].includes(e.category)){
   await setToastCheckMode(db,businessId,"internal",e.category==="authentication"?
    "analytics_auth_failed":"analytics_forbidden");
  }
  if(force)throw e;
  // Transient provider failure never stops the internal check or changes a proven mode.
  return e instanceof ToastApiError&&["authentication","missing_permissions"].includes(e.category)
   ?"internal":mode.toast_check_mode as CheckMode;
 }
}
