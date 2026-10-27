import "server-only";
import {affectedLocalDays} from "../timecardDay";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAdapter} from "./adapter";
import {stageToastCatalog,stageToastRoster} from "./operationalStaging";
import {syncCanonicalCatalog} from "../syncCatalog";
import {syncCanonicalEmployees} from "../syncEmployees";
import {syncToastLaborReadOnly} from "./laborSync";
import {recomputeDailyRollup} from "../rollup";
import {ToastApiError} from "./client";

export type ToastCopyScope={businessId:string;restaurantGuid:string;locationId:string;
 timezone:string;deadlineAt?:number};
export async function copyToastPublishedMenu(db:SupabaseClient,p:ToastCopyScope){
 await stageToastCatalog(db,p); // mig 099 usage checks continue reading staging.
 return syncCanonicalCatalog(db,p.businessId,createToastAdapter({db,...p}),{restaurantGuid:p.restaurantGuid});
}
export async function copyToastStaff(db:SupabaseClient,p:ToastCopyScope){
 await stageToastRoster(db,p); // keeps pilot links and usage checks consistent.
 return syncCanonicalEmployees(db,p.businessId,createToastAdapter({db,...p}),undefined,{restaurantGuid:p.restaurantGuid});
}
/** Only closed time entries are canonical; incomplete rates remain NULL, never zero. */
export async function copyToastAttendance(db:SupabaseClient,p:ToastCopyScope,
 range:{since:Date;until:Date},mode:"historical"|"modified"="historical"){
 await syncToastLaborReadOnly(db,p,range,"attendance",mode);
 const {data,error}=await db.rpc("pos_import_toast_attendance",{
  p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid
 });
 if(error)throw new ToastApiError("unavailable");
 const dates=new Set<string>();
 const info=(data??{}) as {changedIntervals?:{start:string;end:string}[];changed?:number;skipped?:number};
 for(const interval of info.changedIntervals??[]){
  for(const day of affectedLocalDays(interval.start,interval.end,p.timezone))
   dates.add(day);
 }
 for(const date of dates)await recomputeDailyRollup(db,p.businessId,date);
 return {changed:info.changed??0,skipped:info.skipped??0,affectedDates:[...dates]};
}
/** A published menu outage must not unverify credentials or block sales. */
export async function recordToastCopyFailure(db:SupabaseClient,p:ToastCopyScope,
 phase:"menu"|"roster"|"labor",error:unknown){
 const category=error instanceof ToastApiError?error.category:"unavailable";
 const {error:writeError}=await db.from("toast_sync_phase_errors").upsert({
  business_id:p.businessId,restaurant_guid:p.restaurantGuid,phase,
  last_error_category:category,last_failed_at:new Date().toISOString()
 },{onConflict:"business_id,restaurant_guid,phase"});
 if(writeError)throw writeError;
}
