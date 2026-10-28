import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {toastDayFlags,unverifiedToastSalesDates} from "@/lib/pos/toast/reportingCoverage";

/** Shared Toast day policy: failed status is a caveat, never a reason to hide stored rows.
 * A failed status lookup is uncertainty, not evidence that stored facts disappeared.
 * The warning keys carry dates/counts; the chat translates them via DataNotes. */
export async function readToastDayTrust(db:SupabaseClient,businessId:string,from:string,to:string):
 Promise<{blocked:Set<string>;quality:string[]}>{
 // Stored Toast data still needs status evidence if automatic future sync is off.
 // The sync feature flag must not change the trustworthiness of historical rows.
 try{
  // Only canonical Toast order dates can invalidate a mixed-source aggregate.
  // This existing scoped reader distinguishes Toast staging from Square/CSV sales.
  const [flags,canonicalToastDays]=await Promise.all([
   toastDayFlags(db,businessId,from,to),
   unverifiedToastSalesDates(db,businessId,from,to)
  ]);
  // Successful imports at one location do not mask queued, failed or missing imports at another.
  const failed=[...new Set(flags.filter(f=>f.status!=="imported").map(f=>f.date))].sort();
  const withOrders=failed.filter(date=>canonicalToastDays.has(date));
  const otherPosOnly=failed.filter(date=>!canonicalToastDays.has(date));
  const withStatus=new Set(flags.map(f=>f.date));
  const notChecked=[...canonicalToastDays].filter(date=>!withStatus.has(date)).sort();
  const flagged=[...new Set(flags.filter(f=>f.needsLook).map(f=>f.date))].sort();
  return {blocked:new Set<string>(),quality:[
   ...(flagged.length?[needsLookKey(flagged)]:[]),
   ...(withOrders.length?[incompleteDayKey(withOrders)]:[]),
   ...(otherPosOnly.length?["toastFailedNoCanonicalSales:"+otherPosOnly.join(",")]:[]),
   ...(notChecked.length?["toastDayStatusMissing:"+notChecked.join(",")]:[])
  ]};
 }catch{
  return {blocked:new Set(),quality:["toastDayStatusUnavailable"]};
 }
}
export function needsLookKey(dates:readonly string[]):string{
 const unique=[...new Set(dates)].sort(),more=Math.max(0,unique.length-3);
 return "toastDaysNeedLook:"+unique.length+":"+unique.slice(0,3).join(",")+":"+more;
}

export function incompleteDayKey(dates:readonly string[]):string{
 const unique=[...new Set(dates)].sort(),more=Math.max(0,unique.length-3);
 return "toastImportIncompleteDays:"+unique.length+":"+unique.slice(0,3).join(",")+":"+more;
}
