import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** One transactional, date-scoped rebuild for both Toast paths and CSV imports.
 * The database owns the clock, cardinality and locking: no PostgREST row cap,
 * no delete/insert gap, and no synthetic CSV timestamp treated as a real hour.
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
