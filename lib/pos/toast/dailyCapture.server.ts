import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {captureToastRawSample} from "./rawSample.server";
import {addCalendarDays} from "./scheduleDates";
import {DAILY_CAPTURE_LOOKBACK_DAYS,planDailyCaptures,type CaptureLocation,type CoverageRow} from "./dailyCapture";

/** Counts only: never café IDs, payloads or raw errors (the summary is printed in CI logs). */
export type DailyCaptureSummary={
 planned:number;completed:number;partial:number;skipped:number;failed:number;deferred:number;
 reasons:string[];
};
type Capture=typeof captureToastRawSample;

/** Smallest time slot worth starting a capture in; the rest is deferred to the next run. */
const MIN_SLOT_MS=2*60*1000;
/** One café-day never takes the whole run, so other cafés still get captured. */
const MAX_SLOT_MS=15*60*1000;

/** Captures every Toast endpoint for each café's recent closed days that are not yet
 * complete, reusing the diagnostic sampler (redaction, paging, leases, cooldown). */
export async function runDailyToastCapture(db:SupabaseClient,now=new Date(),
 budgetMs=50*60*1000,capture:Capture=captureToastRawSample):Promise<DailyCaptureSummary>{
 const deadline=Date.now()+budgetMs;
 const summary:DailyCaptureSummary={planned:0,completed:0,partial:0,skipped:0,failed:0,deferred:0,reasons:[]};
 const {data:mappings,error}=await db.from("toast_location_mappings")
  .select("business_id,toast_time_zone,closeout_hour").not("verified_at","is",null)
  .order("business_id").order("restaurant_guid").limit(1000);
 if(error){summary.failed++;summary.reasons.push("db_error");return summary;}
 const locations:CaptureLocation[]=(mappings??[]).map(m=>({businessId:String(m.business_id),
  timezone:typeof m.toast_time_zone==="string"?m.toast_time_zone:null,
  closeoutHour:Number.isInteger(m.closeout_hour)?Number(m.closeout_hour):null}));
 if(!locations.length)return summary;
 // Two extra days of margin covers every café timezone around the UTC date line.
 const since=addCalendarDays(now.toISOString().slice(0,10),-(DAILY_CAPTURE_LOOKBACK_DAYS+2));
 const {data:coverage,error:coverageError}=await db.from("toast_api_coverage_v")
  .select("business_id,business_date,reason").gte("business_date",since).limit(20000);
 if(coverageError){summary.failed++;summary.reasons.push("db_error");return summary;}
 const rows:CoverageRow[]=(coverage??[]).map(r=>({businessId:String(r.business_id),
  businessDate:String(r.business_date),reason:typeof r.reason==="string"?r.reason:null}));
 const plan=planDailyCaptures(locations,rows,now);
 summary.planned=plan.length;
 for(const item of plan){
  const remaining=deadline-Date.now();
  if(remaining<MIN_SLOT_MS){summary.deferred++;continue;}
  let result;
  try{result=await capture(item.businessId,item.businessDate,db,Math.min(remaining-60_000,MAX_SLOT_MS));}
  catch{summary.failed++;summary.reasons.push("capture_threw");continue;}
  if(result.reason)summary.reasons.push(result.reason);
  if(result.reason==="partial")summary.partial++;
  else if(result.skipped)summary.skipped++;
  else if(result.failed)summary.failed++;
  else summary.completed++;
 }
 summary.reasons=[...new Set(summary.reasons)].sort();
 return summary;
}
