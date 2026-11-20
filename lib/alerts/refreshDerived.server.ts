import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {cafeToday} from "@/lib/metrics/core/clock";
import {ensureScheduledShiftsThroughDate} from "@/lib/data/materializeSchedule";
import {refreshBusinessAnomalies} from "./businessAnomalies.server";
import {generateAlerts} from "./generate";
import {refreshPriceReviewTasks} from "@/lib/data/operatingTasks";

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
  const [alerts,prices,anomalies]=await Promise.allSettled([generateAlerts(db,businessId),refreshPriceReviewTasks(db,businessId,now),refreshBusinessAnomalies(db,businessId,businessDate,timezone,now)]);
  if(alerts.status==="rejected")throw alerts.reason;
  if(prices.status==="rejected")throw prices.reason;
  if(anomalies.status==="rejected")throw anomalies.reason;
  return {businessDate,alertsCreated:alerts.value.created+anomalies.value};
}
