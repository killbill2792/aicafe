import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getPricingInputs, type PricingItemInput, type PricingBusinessInput } from "./getPricingInputs";
import { businessEconomics, type BusinessEconomicsInput } from "@/lib/calc";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

export type ProfitGoalSimulatorData = {
  currentOperatingMargin: number | null;
  currentMarginQuality: "actual" | "estimated" | "missing";
  canSimulate: boolean;
  unavailableReason: "NOT_ENOUGH_SALES" | "MISSING_PROCESSING_FEES" | "MISSING_PRODUCT_COSTS" | null;
  economics: BusinessEconomicsInput | null;
  items: PricingItemInput[];
  business: PricingBusinessInput;
};

export async function getProfitGoalSimulatorData(): Promise<ProfitGoalSimulatorData> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in first.");

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("business_id, businesses(is_demo)")
    .eq("user_id", user.id);
  if (error) throw error;

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own || own.business_id === DEMO_BUSINESS_ID) throw new Error("Own café not found.");

  const pricing = await getPricingInputs(supabase, own.business_id);
  const hasMissingProductCosts = pricing.items.some(
    (item) => item.unitsSoldInWindow > 0 && item.recipeStatus !== "READY",
  );

  let unavailableReason: ProfitGoalSimulatorData["unavailableReason"] = null;
  if (pricing.business.daysWithSalesInWindow < 7) unavailableReason = "NOT_ENOUGH_SALES";
  else if (pricing.business.processingFeesStatus === "missing") unavailableReason = "MISSING_PROCESSING_FEES";
  else if (hasMissingProductCosts) unavailableReason = "MISSING_PRODUCT_COSTS";

  const economics: BusinessEconomicsInput | null =
    unavailableReason === null
      ? {
          monthlyRevenueCents: pricing.business.monthlyRevenueCents,
          monthlyVariableProductCostCents: pricing.business.monthlyVariableProductCostCents,
          monthlyStaffCostCents: pricing.business.monthlyStaffCostCents,
          monthlyOperatingCostCents: pricing.business.monthlyOperatingCostCents,
          monthlyProcessingFeesCents: pricing.business.monthlyProcessingFeesCents,
        }
      : null;

  const current = economics ? businessEconomics(economics) : null;
  const currentMarginQuality =
    !current
      ? "missing" as const
      : pricing.business.processingFeesStatus === "estimated" ||
          pricing.business.payrollCostsStatus === "estimated" ||
          pricing.business.operatingCostsStatus === "estimated"
        ? "estimated" as const
        : "actual" as const;

  return {
    currentOperatingMargin: current?.operatingMargin ?? null,
    currentMarginQuality,
    canSimulate: economics !== null,
    unavailableReason,
    economics,
    items: pricing.items,
    business: pricing.business,
  };
}
