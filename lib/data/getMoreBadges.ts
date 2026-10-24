import "server-only";
import { normalizeOpenHours } from "@/lib/business/openHours";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { getProcessingFeeEstimateSetup } from "@/lib/data/getProcessingFeeEstimateSetup";
import { getRecurringCosts } from "@/lib/data/getRecurringCosts";
import { getUploadHistory } from "@/lib/data/getUploadHistory";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { MoreBadgeInputs } from "@/lib/viewmodels/moreBadges";

async function readToastState(businessId: string): Promise<MoreBadgeInputs["toast"]> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return undefined;
  const db = createAdminSupabaseClient();
  const [credential, locations, health] = await Promise.all([
    db.from("toast_api_credentials").select("state,last_error_category")
      .eq("business_id", businessId).maybeSingle(),
    db.from("toast_location_mappings").select("verified_at")
      .eq("business_id", businessId),
    db.from("toast_sync_health").select("last_failure_category")
      .eq("business_id", businessId),
  ]);
  if (credential.error || locations.error || health.error) return undefined;
  return {
    state: credential.data?.state ?? "not_connected",
    hasError: Boolean(credential.data?.last_error_category ||
      health.data?.some((row) => row.last_failure_category)),
    verifiedLocation: Boolean(locations.data?.some((row) => row.verified_at)),
  };
}

/** Read-only, scoped to the user's real café. Unavailable sources have no badge. */
export async function getMoreBadgeInputs(userId: string | undefined): Promise<MoreBadgeInputs> {
  if (!userId || !isSupabaseConfigured()) return {};
  const db = await createServerSupabaseClient();
  const businessId = await getActiveBusinessId(userId);
  const { data: membership, error: membershipError } = await db.from("memberships")
    .select("role, businesses(is_demo,currency)").eq("business_id", businessId)
    .eq("user_id", userId).maybeSingle();
  if (membershipError || !membership) return {};
  const raw = membership.businesses as unknown as
    {is_demo: boolean;currency: string} | {is_demo: boolean;currency: string}[] | null;
  const business = Array.isArray(raw) ? raw[0] : raw;
  if (!business || business.is_demo) return {};

  const [hours, uploads, fees, bills, alerts, toast] = await Promise.allSettled([
    db.from("locations").select("open_hours").eq("business_id", businessId)
      .order("name").limit(1).maybeSingle(),
    getUploadHistory(),
    getProcessingFeeEstimateSetup(),
    getRecurringCosts(),
    db.from("alerts").select("id", { head: true, count: "exact" })
      .eq("business_id", businessId).in("status", ["new", "seen"]),
    membership.role === "owner" ? readToastState(businessId) : Promise.resolve(undefined),
  ]);

  const result: MoreBadgeInputs = { currency: business.currency || "USD" };
  if (hours.status === "fulfilled" && !hours.value.error)
    result.openHours = normalizeOpenHours(hours.value.data?.open_hours);
  if (uploads.status === "fulfilled") result.uploads = uploads.value;
  if (fees.status === "fulfilled") result.missingFeeDays = fees.value.coverage.missingDays;
  if (bills.status === "fulfilled") result.bills = bills.value;
  if (alerts.status === "fulfilled" && !alerts.value.error)
    result.alertCount = alerts.value.count;
  if (toast.status === "fulfilled") result.toast = toast.value;
  return result;
}
