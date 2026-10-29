import {addCalendarDays,eligibleClosedDay,localClock} from "./scheduleDates";

/** How many recent closed business days the daily capture keeps complete. A missed
 * or partial run is retried on the next run instead of leaving a permanent gap. */
export const DAILY_CAPTURE_LOOKBACK_DAYS=3;

/** Coverage reasons that mean the latest capture of a day did not finish. */
const INCOMPLETE_REASONS=new Set([
 "skipped_time_budget","skipped_endpoint_budget","skipped_lease_lost",
 "skipped_interrupted","sample_write_failed","not_attempted",
]);

export type CaptureLocation={businessId:string;timezone:string|null;closeoutHour:number|null};
export type CoverageRow={businessId:string;businessDate:string;reason:string|null};
export type PlannedCapture={businessId:string;businessDate:string};

/** Closed business days to keep captured for one café, oldest first. Before today's
 * closeout (+1h) has passed, yesterday is still open, so the latest closed day is
 * the day before it. */
export function recentClosedDays(now:Date,timezone:string,closeoutHour:number,
 lookback=DAILY_CAPTURE_LOOKBACK_DAYS):string[]{
 const latest=eligibleClosedDay(now,timezone,closeoutHour)??addCalendarDays(localClock(now,timezone).today,-2);
 return Array.from({length:lookback},(_,i)=>addCalendarDays(latest,i-lookback+1));
}

/** A day is complete when its latest capture has at least one endpoint and none
 * of them stopped early. A day with no capture at all is not complete. */
export function completeDays(rows:readonly CoverageRow[]):Set<string>{
 const seen=new Map<string,boolean>();
 for(const row of rows){
  const key=row.businessId+"|"+row.businessDate;
  const stopped=row.reason!==null&&INCOMPLETE_REASONS.has(row.reason);
  seen.set(key,(seen.get(key)??true)&&!stopped);
 }
 return new Set([...seen].filter(([,complete])=>complete).map(([key])=>key));
}

/** One capture per café and missing day, oldest day first so history fills in order.
 * Cafés without a Toast timezone or closeout hour are skipped, never guessed. */
export function planDailyCaptures(locations:readonly CaptureLocation[],
 coverage:readonly CoverageRow[],now:Date):PlannedCapture[]{
 const done=completeDays(coverage);
 const seen=new Set<string>();
 const plan:PlannedCapture[]=[];
 for(const location of locations){
  if(seen.has(location.businessId))continue;
  seen.add(location.businessId);
  if(!location.timezone||location.closeoutHour===null||!Number.isInteger(location.closeoutHour))continue;
  for(const businessDate of recentClosedDays(now,location.timezone,location.closeoutHour)){
   if(!done.has(location.businessId+"|"+businessDate))plan.push({businessId:location.businessId,businessDate});
  }
 }
 return plan.sort((a,b)=>a.businessDate.localeCompare(b.businessDate)||a.businessId.localeCompare(b.businessId));
}
