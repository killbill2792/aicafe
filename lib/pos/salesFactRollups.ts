import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Reconcile saved historical buckets after promotion. Current sales are read
 * from source and accepted order records. PostgreSQL removes a saved day
 * only when it can reproduce every bucket and keeps non-reproducible history.
 */
export async function rebuildSalesFactRollups(
  db: SupabaseClient,
  businessId: string,
  dates: string[],
  _timezone: string,
): Promise<void> {
  // Keep the existing call contract; the SQL routine reads the authoritative business timezone.
  void _timezone;
  const uniqueDates = [...new Set(dates)].sort();
  for (const date of uniqueDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T12:00:00Z"))) {
      throw new Error("Invalid business date for sales rollup");
    }
    const { error } = await db.rpc("pos_rebuild_sales_fact_rollups_v1", {
      p_business_id: businessId,
      p_business_date: date,
    });
    if (error) throw error;
  }
}
