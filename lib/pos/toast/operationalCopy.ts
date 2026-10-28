import "server-only";
import {randomUUID} from "node:crypto";
import {affectedLocalDays} from "../timecardDay";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createToastAdapter} from "./adapter";
import {stageToastCatalog,stageToastRoster} from "./operationalStaging";
import {syncCanonicalCatalog} from "../syncCatalog";
import {syncCanonicalEmployees} from "../syncEmployees";
import {syncToastLaborReadOnly} from "./laborSync";
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
 return importStagedToastAttendance(db,p);
}
/** Promote all already-staged entries, even when the Toast API has no changes. */
export async function importStagedToastAttendance(db:SupabaseClient,p:ToastCopyScope){
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
 // Durable jobs survive an interrupted cron slice, including corrected old dates.
 for(const date of dates){
  const {error:queueError}=await db.from("toast_rollup_refresh_jobs").upsert({
   business_id:p.businessId,business_date:date,retry_at:new Date().toISOString(),
   generation:randomUUID()
  },{onConflict:"business_id,business_date"});
  if(queueError)throw new ToastApiError("unavailable");
 }
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
 // Surface source-copy failures on the normal owner-facing Toast health path.
 // The credential's verified state is intentionally left unchanged.
 const {error:healthError}=await db.from("toast_sync_health").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   last_attempt_at:new Date().toISOString(),last_failure_category:category,
 },{onConflict:"business_id,restaurant_guid"});
 if(healthError)throw healthError;
}
