import "server-only";
import {randomUUID} from "node:crypto";
import {formatInTimeZone,fromZonedTime} from "date-fns-tz";
import type {SupabaseClient} from "@supabase/supabase-js";
import {addCalendarDays} from "./scheduleDates";
import {hasIncompleteToastLabor,type StagedToastShift,type CanonicalToastShift} from "./laborCoverage";
import {readAllPosRows,posIdBatches} from "../pagedReads";

/** Repair only previously imported, already-canonical Toast days whose old
 * rollup still says missing. This runs during the existing attendance copy;
 * it does not start another POS import, fetch, archive or cron.
 * Staged but unlinked/incomplete days deliberately remain missing.
 */
export async function queueStaleToastLaborRollups(
 db:SupabaseClient,businessId:string,timezone:string,
 now:Date=new Date(),limit=5,
):Promise<string[]>{
 const today=formatInTimeZone(now,timezone,"yyyy-MM-dd");
 const from=addCalendarDays(today,-84);
 const [rollups,days]=await Promise.all([
  db.from("daily_rollups").select("business_date")
   .eq("business_id",businessId).eq("labor_wage_status","missing")
   .gte("business_date",from).lt("business_date",today)
   .order("business_date",{ascending:false}).limit(84),
  db.from("toast_day_status").select("business_date")
   .eq("business_id",businessId).eq("import_state","imported")
   .gte("business_date",from).lt("business_date",today)
   .order("business_date",{ascending:false}).limit(1000),
 ]);
 if(rollups.error||days.error)throw new Error("Toast labor repair evidence unavailable");
 const imported=new Set((days.data??[]).map(d=>d.business_date));
 const queued:string[]=[];
 for(const row of rollups.data??[]){
  if(queued.length>=limit)break;
  const day=row.business_date;
  if(!imported.has(day))continue;
  const start=fromZonedTime(day+"T00:00:00",timezone).toISOString();
  const end=fromZonedTime(addCalendarDays(day,1)+"T00:00:00",timezone).toISOString();
  const staged=await readAllPosRows((a,b)=>db.from("toast_labor_entries")
   .select("restaurant_guid,external_time_entry_id,clock_in,clock_out,hourly_wage_cents,provider_regular_hours,provider_overtime_hours,deleted")
   .eq("business_id",businessId).eq("deleted",false)
   .lt("clock_in",end).gt("clock_out",start)
   .order("restaurant_guid").order("external_time_entry_id").range(a,b),
   "stored Toast labor repair");
  // No staged time entries is NOT proof of a legitimate zero-pay day.
  if(!staged.length)continue;
  const ids=(staged as StagedToastShift[]).map(e=>
   `toast:${e.restaurant_guid}:${e.external_time_entry_id}`);
  const canonical:CanonicalToastShift[]=[];
  for(const batch of posIdBatches(ids)){
   canonical.push(...await readAllPosRows((a,b)=>db.from("timecards")
    .select("pos_timecard_id,clock_in,clock_out,hourly_wage_cents,wage_source,source_type,provider_regular_hours,provider_overtime_hours")
    .eq("business_id",businessId).in("pos_timecard_id",batch)
    .order("pos_timecard_id").range(a,b),"canonical Toast repair"));
  }
  if(hasIncompleteToastLabor(staged as StagedToastShift[],canonical))continue;
  const {error}=await db.from("toast_rollup_refresh_jobs").upsert({
   business_id:businessId,business_date:day,retry_at:now.toISOString(),
   generation:randomUUID(),
  },{onConflict:"business_id,business_date",ignoreDuplicates:true});
  if(error)throw new Error("Toast labor refresh queue unavailable");
  queued.push(day);
 }
 return queued;
}
