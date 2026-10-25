import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { logQueryError } from "@/lib/data/queryError";

/**
 * Clear only upload-era unmatched-sales alerts when *all* catalog review rows
 * for this owner-selected business are resolved. Never use the alert's static
 * item names to decide if work is still outstanding.
 *
 * The caller must authenticate the owner and bind businessId to that session.
 * This helper has no service-role access, and always filters reads and writes by
 * business_id; repeating it after a successful match is safe.
 */
export async function resolveUnmatchedAlertsIfClear(
  db: SupabaseClient,
  businessId: string,
  options?: { nonBlocking?: boolean },
): Promise<boolean> {
  if (businessId === DEMO_BUSINESS_ID) return false;
  try {
  const { data: pending, error: pendingError } = await db
    .from("pos_catalog_matches")
    .select("id")
    .eq("business_id", businessId)
    .eq("status", "needs_review")
    .limit(1);
  if (pendingError) {
    logQueryError("resolveUnmatchedAlertsIfClear:review", pendingError);
    throw new Error("catalog_review_unavailable");
  }
  if ((pending ?? []).length > 0) return false;
  const { error: resolveError } = await db
    .from("alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("kind", "unmatched_sales_items")
    .in("status", ["new", "seen"]);
  if (resolveError) {
    logQueryError("resolveUnmatchedAlertsIfClear:alerts", resolveError);
    throw new Error("alert_resolution_failed");
  }
  return true;
  } catch (error) {
    // Imported sales are already durable when this is called in non-blocking
    // mode. Do not misreport that completed import as failed because its
    // secondary, retryable alert cleanup encountered an outage.
    if (options?.nonBlocking) return false;
    throw error;
  }
}
