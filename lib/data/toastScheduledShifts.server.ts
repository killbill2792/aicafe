import "server-only";
import {formatInTimeZone} from "date-fns-tz";
import type {SupabaseClient} from "@supabase/supabase-js";

export type ExternalPosShift={
 id:string;employeeName:string;employeeId:string|null;start:string;end:string;
 source:"toast";paid:false;locationId:string;
};
/** Toast's scheduled/planned shifts are NOT timecards. This reader never
 * converts them to a paid shift, and never adds them to schedule totals. */
export async function readToastPlannedShifts(db:SupabaseClient,businessId:string,
 from:string,to:string,timezone:string):Promise<ExternalPosShift[]>{
 const first=new Date(from+"T00:00:00Z").getTime()-2*86400000;
 const last=new Date(to+"T23:59:59Z").getTime()+2*86400000;
 if(!Number.isFinite(first)||!Number.isFinite(last)||from>to)
  throw new Error("Invalid Toast schedule window");
 // Check the authorized business has Toast mappings before reading restricted POS tables.
 const mappings=await db.from("toast_location_mappings").select("location_id,restaurant_guid")
  .eq("business_id",businessId);
 if(mappings.error)throw mappings.error;
 if(!mappings.data?.length)return [];
 const [planned,roster]=await Promise.all([
  db.from("pos_scheduled_shifts")
   .select("location_id,external_shift_id,external_employee_id,scheduled_start,scheduled_end")
   .eq("business_id",businessId).eq("provider","toast").eq("deleted",false)
   .gte("scheduled_end",new Date(first).toISOString())
   .lte("scheduled_start",new Date(last).toISOString())
   .order("scheduled_start").limit(1001),
   db.from("toast_employee_directory")
   .select("restaurant_guid,employee_guid,display_name,linked_employee_id")
   .eq("business_id",businessId).limit(5001),
 ]);
 if(planned.error)throw planned.error;
 if(roster.error)throw roster.error;
 if((planned.data??[]).length>1000||(roster.data??[]).length>5000)
  throw new Error("Toast schedule snapshot truncated");
 const locationMap=new Map((mappings.data??[]).map(r=>[r.location_id,r.restaurant_guid]));
 // Prefer the name the owner uses in Team, including any manual rename.
 // Toast's roster label is only a fallback for unlinked staff.
 const linkedIds=[...new Set((roster.data??[])
  .map(row=>row.linked_employee_id as string|null).filter((id):id is string=>Boolean(id)))];
 const canonical=linkedIds.length?await db.from("employees").select("id,display_name")
  .eq("business_id",businessId).in("id",linkedIds).limit(5001):
  {data:[] as Array<{id:string;display_name:string}>,error:null};
 if(canonical.error)throw canonical.error;
 if((canonical.data??[]).length>5000)throw new Error("Toast linked roster truncated");
 const canonicalNames=new Map((canonical.data??[]).map(row=>[row.id,row.display_name]));
 const employeesByPos=new Map((roster.data??[]).map(row=>[
  row.restaurant_guid+":"+row.employee_guid,row.linked_employee_id as string|null
 ]));
 const employeeNames=new Map((roster.data??[]).map(row=>[
  row.restaurant_guid+":"+row.employee_guid,
  canonicalNames.get(row.linked_employee_id)??row.display_name
 ]));
 return (planned.data??[]).filter(row=>{
  const start=formatInTimeZone(new Date(row.scheduled_start),timezone,"yyyy-MM-dd");
  const end=formatInTimeZone(new Date(row.scheduled_end),timezone,"yyyy-MM-dd");
  return start<=to&&end>=from;
 }).map(row=>({
  id:row.external_shift_id,
  employeeName:employeeNames.get((locationMap.get(row.location_id)??"")+":"+row.external_employee_id)
   ??"Toast team member",
  start:row.scheduled_start,end:row.scheduled_end,
  employeeId:employeesByPos.get((locationMap.get(row.location_id)??"")+":"+row.external_employee_id)??null,
  locationId:row.location_id,source:"toast" as const,paid:false as const,
 }));
}
