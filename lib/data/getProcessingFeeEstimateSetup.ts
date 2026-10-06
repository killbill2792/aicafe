import "server-only";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getOwnerConfirmedProcessingFeePlans,
  ownerConfirmedPlanForDate,
} from "@/lib/pos/processingFeeEstimate.server";
import type { OwnerConfirmedProcessingFeePlan } from "@/lib/pos/processingFeeEstimate";

export type ProcessingFeeEstimateSetup = {
  today: string;
  plan: OwnerConfirmedProcessingFeePlan | null;
  coverage: { salesDays: number; actualDays: number; estimatedDays: number; missingDays: number };
};

export async function getProcessingFeeEstimateSetup(): Promise<ProcessingFeeEstimateSetup> {
  if (!isSupabaseConfigured()) {
    return {
      today: formatInTimeZone(new Date(), "America/Los_Angeles", "yyyy-MM-dd"),
      plan: null,
      coverage: { salesDays: 0, actualDays: 0, estimatedDays: 0, missingDays: 0 },
    };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      today: formatInTimeZone(new Date(), "America/Los_Angeles", "yyyy-MM-dd"),
      plan: null,
      coverage: { salesDays: 0, actualDays: 0, estimatedDays: 0, missingDays: 0 },
    };
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select("business_id, businesses(is_demo, timezone)")
    .eq("user_id", user.id);
  if (membershipError) throw membershipError;
  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as
      | { is_demo: boolean; timezone: string }
      | { is_demo: boolean; timezone: string }[]
      | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own) throw new Error("Own café not found.");
  const rawBusiness = own.businesses as unknown as
    | { is_demo: boolean; timezone: string }
    | { is_demo: boolean; timezone: string }[];
  const business = Array.isArray(rawBusiness) ? rawBusiness[0] : rawBusiness;
  const businessId = own.business_id;
  const timezone = business?.timezone ?? "America/Los_Angeles";
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");

  const [plans, rollupsResult] = await Promise.all([
    getOwnerConfirmedProcessingFeePlans(supabase, businessId),
    supabase
      .from("daily_rollups")
      .select("net_sales_cents, card_fees_status")
      .eq("business_id", businessId)
      .gte("business_date", fromDate)
      .lte("business_date", today),
  ]);
  if (rollupsResult.error) throw rollupsResult.error;

  const salesDays = (rollupsResult.data ?? []).filter((row) => Number(row.net_sales_cents) > 0);
  const coverage = {
    salesDays: salesDays.length,
    actualDays: salesDays.filter((row) => row.card_fees_status === "actual").length,
    estimatedDays: salesDays.filter((row) => row.card_fees_status === "estimated").length,
    missingDays: salesDays.filter((row) => row.card_fees_status === "missing").length,
  };

  return {
    today,
    plan: ownerConfirmedPlanForDate(plans, today) ?? plans.at(-1) ?? null,
    coverage,
  };
}
