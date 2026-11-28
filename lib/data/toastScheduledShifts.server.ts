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
  db.from("cv_shifts").select("source_ref,data").eq("business_id",businessId).eq("source","toast")
   // Restrict by date prefixes over the padded UTC window. The exact overlap
   // check below uses dates in the café's own timezone.
   .gte("data->>scheduled_end",new Date(first).toISOString().slice(0,10))
   .lt("data->>scheduled_start",new Date(last+86400000).toISOString().slice(0,10))
   .order("data->>scheduled_start").order("source_ref").limit(1001),
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
 return (planned.data??[]).flatMap(row=>{
  const shift=row.data;
  const start=new Date(shift.scheduled_start),end=new Date(shift.scheduled_end);
  if(formatInTimeZone(start,timezone,"yyyy-MM-dd")>to||formatInTimeZone(end,timezone,"yyyy-MM-dd")<from)return [];
  const employeeKey=(locationMap.get(shift.location_id)??"")+":"+shift.employee_id;
  return [{id:row.source_ref.slice("toast-shift:".length),employeeName:employeeNames.get(employeeKey)??"Toast team member",
   start:shift.scheduled_start,end:shift.scheduled_end,employeeId:employeesByPos.get(employeeKey)??null,
   locationId:shift.location_id,source:"toast",paid:false}];
 });
}
