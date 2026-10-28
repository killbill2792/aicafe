import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {toastDayFlags,unverifiedToastSalesDates} from "@/lib/pos/toast/reportingCoverage";

/** Shared Toast day policy: only explicit failed/missing status excludes a day.
 * A failed status lookup is uncertainty, not evidence that stored facts disappeared.
 * The warning keys carry dates/counts; the chat translates them via DataNotes. */
export async function readToastDayTrust(db:SupabaseClient,businessId:string,from:string,to:string):
 Promise<{blocked:Set<string>;quality:string[]}>{
 if(process.env.TOAST_AUTO_IMPORT_ENABLED!=="true")
  return {blocked:new Set(),quality:[]};
 try{
  // Only canonical Toast order dates can invalidate a mixed-source aggregate.
  // This existing scoped reader distinguishes Toast staging from Square/CSV sales.
  const [flags,canonicalToastDays]=await Promise.all([
   toastDayFlags(db,businessId,from,to),
   unverifiedToastSalesDates(db,businessId,from,to)
  ]);
  // If at least one location imported on a date, retain stored facts from it.
  // The failed/missing location remains a caveat, not a reason to hide the day.
  const imported=new Set(flags.filter(f=>f.status==="imported").map(f=>f.date));
  const failed=new Set(flags.filter(f=>f.status==="failed"||f.status==="missing")
   .map(f=>f.date).filter(date=>!imported.has(date)));
  const blocked=new Set([...failed].filter(date=>canonicalToastDays.has(date)));
  const otherPosOnly=[...failed].filter(date=>!canonicalToastDays.has(date)).sort();
  const withStatus=new Set(flags.map(f=>f.date));
  const notChecked=[...canonicalToastDays].filter(date=>!withStatus.has(date)).sort();
  const flagged=[...new Set(flags.filter(f=>f.needsLook).map(f=>f.date))].sort();
  const excluded=[...blocked].sort();
  return {blocked,quality:[
   ...(flagged.length?[needsLookKey(flagged)]:[]),
   ...(otherPosOnly.length?["toastFailedNoCanonicalSales:"+otherPosOnly.join(",")]:[]),
   ...(notChecked.length?["toastDayStatusMissing:"+notChecked.join(",")]:[]),
   ...(excluded.length?["toastExcludedDays:"+excluded.join(",")]:[])
  ]};
 }catch{
  return {blocked:new Set(),quality:["toastDayStatusUnavailable"]};
 }
}
export function needsLookKey(dates:readonly string[]):string{
 const unique=[...new Set(dates)].sort(),more=Math.max(0,unique.length-3);
 return "toastDaysNeedLook:"+unique.length+":"+unique.slice(0,3).join(",")+":"+more;
}
