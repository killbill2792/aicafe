/** Raj Cafe daily-rollup computation preview. Caller must provide a scoped
 * database client and Raj Cafe business ID. ALWAYS read-only; no CLI connects
 * to production and no migration or data update is performed here. */
import { recomputeDailyRollup } from "../lib/pos/rollup";
import type { SupabaseClient } from "@supabase/supabase-js";

export const rajCafeDates=Array.from({length:14},(_,i)=>new Date(Date.UTC(2026,7,22+i)).toISOString().slice(0,10));
export async function planRajCafeRollups(db:SupabaseClient,businessId:string) {
  const proposed=[];
  for(const date of rajCafeDates) {
    const row=await recomputeDailyRollup(db,businessId,date,{dryRun:true});
    proposed.push({date,dryRun:true,proposed:row,
      note:"Read-only preview. No fee estimate materialization; existing recorded fees only."});
  }
  return proposed;
}
