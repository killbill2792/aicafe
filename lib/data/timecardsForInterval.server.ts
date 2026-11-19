import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readAllPosRows} from "@/lib/pos/pagedReads";

/** Single paginated canonical interval read shared by payroll rollup and the
 * proactive hourly pressure monitor. Caller scope is already server verified.
 * Preserve owner-schedule rows for the existing caller-side coverage policy. */
export async function readTimecardsForInterval(supabase:SupabaseClient,businessId:string,dayStartUtc:string,dayEndUtc:string){
  return readAllPosRows((first,last)=>supabase
    .from("timecards")
    .select("id, pos_timecard_id, clock_in, clock_out, hourly_wage_cents, wage_source, breaks, source_type, provider_regular_hours, provider_overtime_hours")
    .eq("business_id", businessId)
    .lt("clock_in", dayEndUtc)
    .or("clock_out.is.null,clock_out.gt."+dayStartUtc)
    .order("id").range(first,last),"daily timecards");
}
