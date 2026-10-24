import "server-only";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { normalizeOpenHours } from "@/lib/business/openHours";
import { selectedFeeCoverageForSalesDays } from "@/components/more/processingFeeDefaults";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { getUploadHistory } from "@/lib/data/getUploadHistory";
import type { RecurringCostRow } from "@/lib/data/getRecurringCosts";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { MoreBadgeInputs } from "@/lib/viewmodels/moreBadges";

type CafeDb = Awaited<ReturnType<typeof createServerSupabaseClient>>;

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

async function readMissingFeeDays(db: CafeDb, businessId: string, timezone: string): Promise<number | undefined> {
  // Match ProcessingFees' rolling 90-day, positive-sales-day coverage calculation,
  // without loading unrelated order/credential data or selecting a different café.
  let today: string;
  let fromDate: string;
  try {
    today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
    fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");
  } catch {
    return undefined;
  }
  const [sales, facts] = await Promise.all([
    db.from("daily_rollups").select("business_date,net_sales_cents")
      .eq("business_id", businessId).gte("business_date", fromDate).lte("business_date", today),
    db.from("processing_fee_daily_facts").select("business_date,status")
      .eq("business_id", businessId).gte("business_date", fromDate).lte("business_date", today),
  ]);
  if (sales.error || facts.error) return undefined;
  return selectedFeeCoverageForSalesDays(sales.data ?? [], facts.data ?? [])
    .filter((day) => day.status === "missing").length;
}

/** Read-only, scoped to the user's selected real café. Unavailable sources have no badge. */
export async function getMoreBadgeInputs(userId: string | undefined): Promise<MoreBadgeInputs> {
  if (!userId || !isSupabaseConfigured()) return {};
  const db = await createServerSupabaseClient();
  const businessId = await getActiveBusinessId(userId);
  const { data: membership, error: membershipError } = await db.from("memberships")
    .select("role, businesses(is_demo,currency,timezone)").eq("business_id", businessId)
    .eq("user_id", userId).maybeSingle();
  if (membershipError || !membership) return {};
  const raw = membership.businesses as unknown as
    {is_demo: boolean; currency: string; timezone: string} |
    {is_demo: boolean; currency: string; timezone: string}[] | null;
  const business = Array.isArray(raw) ? raw[0] : raw;
  if (!business || business.is_demo) return {};

  const [hours, uploads, fees, bills, alerts, toast] = await Promise.allSettled([
    db.from("locations").select("open_hours").eq("business_id", businessId)
      .order("name").limit(1).maybeSingle(),
    getUploadHistory(),
    readMissingFeeDays(db, businessId, business.timezone),
    db.from("recurring_costs")
      .select("id,category_code,label,amount_cents,frequency,due_day,is_estimate")
      .eq("business_id", businessId).is("active_to", null),
    db.from("alerts").select("id", { head: true, count: "exact" })
      .eq("business_id", businessId).in("status", ["new", "seen"]),
    membership.role === "owner" ? readToastState(businessId) : Promise.resolve(undefined),
  ]);

  const result: MoreBadgeInputs = { currency: business.currency || "USD" };
  if (hours.status === "fulfilled" && !hours.value.error)
    result.openHours = normalizeOpenHours(hours.value.data?.open_hours);
  if (uploads.status === "fulfilled") result.uploads = uploads.value;
  if (fees.status === "fulfilled") result.missingFeeDays = fees.value;
  // The regular Bills loader currently hides query errors by returning [].
  // A separate error-aware read prevents a failed DB query from claiming "Rent missing".
  if (bills.status === "fulfilled" && !bills.value.error) {
    result.bills = (bills.value.data ?? []).map((row): RecurringCostRow => ({
      id: row.id, categoryCode: row.category_code as RecurringCostRow["categoryCode"],
      label: row.label, amountCents: row.amount_cents,
      frequency: row.frequency as RecurringCostRow["frequency"],
      dueDay: row.due_day, isEstimate: row.is_estimate,
    }));
  }
  if (alerts.status === "fulfilled" && !alerts.value.error)
    result.alertCount = alerts.value.count;
  if (toast.status === "fulfilled") result.toast = toast.value;
  return result;
}
