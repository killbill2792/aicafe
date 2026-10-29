import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {cafeToday} from "@/lib/metrics/core/clock";
import {ensureScheduledShiftsThroughDate} from "@/lib/data/materializeSchedule";
import {generateAlerts} from "./generate";

/** Idempotent, explicitly invoked refresh. NEVER called by snapshot/page loaders.
 * Toast/Square import handlers can invoke this after their commit is complete.
 * With no new migration, existing schedule-materialization and alert deduplication
 * still provide the same repeat-run semantics as before.
 */
export async function refreshDerivedForBusiness(
  db:SupabaseClient,businessId:string,timezone:string,now:Date=new Date(),
):Promise<{businessDate:string;alertsCreated:number}>{
  if(!businessId||!timezone)throw new Error("Missing café refresh scope");
  const businessDate=cafeToday(timezone,now);
  // Alerts read timecards/rollups, therefore schedules must be reconciled first.
  await ensureScheduledShiftsThroughDate(db,businessId,timezone,businessDate);
  const alerts=await generateAlerts(db,businessId);
  return {businessDate,alertsCreated:alerts.created};
}
