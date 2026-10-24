import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {ToastApiError} from "./client";
import {createToastAdapter,type ToastAttendanceFact,type ToastScheduledShift} from "./adapter";
type Range={since:Date;until:Date};
type LocationParams={businessId:string;locationId:string;restaurantGuid:string;deadlineAt?:number};
function checkedRange(range:Range){
 if(!Number.isFinite(range.since.getTime())||!Number.isFinite(range.until.getTime())||
   range.until<=range.since||range.until.getTime()-range.since.getTime()>30*86400000)
   throw new ToastApiError("invalid_response");
}
export function mapToastLaborEntry(p:LocationParams,f:ToastAttendanceFact) {
 if(f.externalLocationId!==p.restaurantGuid)throw new ToastApiError("unauthorized_location");
 return {
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   location_id:p.locationId,external_time_entry_id:f.externalTimeEntryId,
   external_employee_id:f.externalEmployeeId,clock_in:f.clockIn,
   clock_out:f.clockOut,hourly_wage_cents:f.hourlyWageCents,
   wage_status:f.hourlyWageCents===null?"missing":"verified",
   breaks:f.breaks,deleted:f.deleted,provider_modified_at:f.modifiedAt??null,
   fetched_at:new Date().toISOString(),
 };
}
export function mapToastScheduledShift(p:LocationParams,s:ToastScheduledShift) {
 if(s.externalLocationId!==p.restaurantGuid||Date.parse(s.scheduledEnd)<=Date.parse(s.scheduledStart))
   throw new ToastApiError("invalid_response");
 return {
   business_id:p.businessId,location_id:p.locationId,
   provider:"toast",external_shift_id:s.externalShiftId,
   external_employee_id:s.externalEmployeeId,external_job_id:s.externalJobId,
   scheduled_start:s.scheduledStart,scheduled_end:s.scheduledEnd,
   deleted:s.deleted,last_synced_at:new Date().toISOString(),
 };
}
export async function syncToastLaborReadOnly(db:SupabaseClient,p:LocationParams,
 range:Range,kind:"attendance"|"schedules",mode:"historical"|"modified"="historical") {
 checkedRange(range);
 const {data:mapping,error}=await db.from("toast_location_mappings")
 .select("verified_at,location_id").eq("business_id",p.businessId)
 .eq("restaurant_guid",p.restaurantGuid).maybeSingle();
 if(error||!mapping?.verified_at||mapping.location_id!==p.locationId)
   throw new ToastApiError("unauthorized_location");
 const adapter=createToastAdapter({db,businessId:p.businessId,restaurantGuid:p.restaurantGuid});
 if(kind==="attendance"){
   const rows=mode==="modified"?await adapter.fetchAttendanceChanges(range):
     await adapter.fetchAttendanceFacts(range);
   if(rows.length>5000)throw new ToastApiError("invalid_response");
   const normalized=rows.map(f=>mapToastLaborEntry(p,f));
   // No old records are erased on missing API responses; deletion must be explicit from Toast.
   for(let offset=0;offset<normalized.length;offset+=100){
     const {error:save}=await db.rpc("toast_stage_labor_entries",{
       p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
       p_location_id:p.locationId,p_rows:normalized.slice(offset,offset+100),
     });
     if(save)throw new ToastApiError("unavailable");
   }
   const {error:health}=await db.from("toast_sync_health").upsert({
      business_id:p.businessId,restaurant_guid:p.restaurantGuid,
      last_attempt_at:new Date().toISOString(),last_time_entry_fetch_at:new Date().toISOString(),
      last_failure_category:null,
   },{onConflict:"business_id,restaurant_guid"});
   if(health)throw new ToastApiError("unavailable");
   return {kind,staged:normalized.length,canonicalPayrollChanged:false};
 }
 const rows=await adapter.fetchScheduledShifts(range);
 if(rows.length>5000)throw new ToastApiError("invalid_response");
 const normalized=rows.map(s=>mapToastScheduledShift(p,s));
 // A complete window is applied in one SQL transaction; never delete on partial API success.
 const {error:save}=await db.rpc("toast_apply_schedule_window",{
   p_business_id:p.businessId,p_restaurant_guid:p.restaurantGuid,
   p_location_id:p.locationId,p_since:range.since.toISOString(),p_until:range.until.toISOString(),
   p_rows:normalized,
 });
 if(save)throw new ToastApiError("unavailable");
 const {error:health}=await db.from("toast_sync_health").upsert({
   business_id:p.businessId,restaurant_guid:p.restaurantGuid,
   last_attempt_at:new Date().toISOString(),last_schedule_fetch_at:new Date().toISOString(),
   last_failure_category:null,
 },{onConflict:"business_id,restaurant_guid"});
 if(health)throw new ToastApiError("unavailable");
 return {kind,staged:normalized.length,canonicalPayrollChanged:false};
}
