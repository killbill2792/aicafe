import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getPricingInputs, type PricingItemInput, type PricingBusinessInput } from "./getPricingInputs";
import { businessEconomics } from "@/lib/calc";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

export type OwnerEconomicsSettings = {
  targetOperatingMargin: number;
  targetOperatingMarginStatus: "default" | "confirmed";
  payrollTaxRate: number;
  payrollTaxRateStatus: "estimated" | "confirmed";
  currentOperatingMargin: number | null;
  currentMarginQuality: "actual" | "estimated" | "missing";
  pricing: { items: PricingItemInput[]; business: PricingBusinessInput };
};

export async function getOwnerEconomicsSettings(): Promise<OwnerEconomicsSettings> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in first.");

  const { data: memberships, error: membershipError } = await supabase
    .from("memberships")
    .select(
      "business_id, businesses(is_demo, payroll_tax_rate, payroll_tax_rate_status, target_operating_margin, target_operating_margin_status)",
    )
    .eq("user_id", user.id);
  if (membershipError) throw membershipError;

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as
      | {
          is_demo: boolean;
          payroll_tax_rate: number;
          payroll_tax_rate_status: "estimated" | "confirmed";
          target_operating_margin: number;
          target_operating_margin_status: "default" | "confirmed";
        }
      | {
          is_demo: boolean;
          payroll_tax_rate: number;
          payroll_tax_rate_status: "estimated" | "confirmed";
          target_operating_margin: number;
          target_operating_margin_status: "default" | "confirmed";
        }[]
      | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own || own.business_id === DEMO_BUSINESS_ID) throw new Error("Own café not found.");

  const raw = own.businesses as unknown as
    | {
        is_demo: boolean;
        payroll_tax_rate: number;
        payroll_tax_rate_status: "estimated" | "confirmed";
        target_operating_margin: number;
        target_operating_margin_status: "default" | "confirmed";
      }
    | {
        is_demo: boolean;
        payroll_tax_rate: number;
        payroll_tax_rate_status: "estimated" | "confirmed";
        target_operating_margin: number;
        target_operating_margin_status: "default" | "confirmed";
      }[];
  const business = Array.isArray(raw) ? raw[0] : raw;

  const pricing = await getPricingInputs(supabase, own.business_id);
  const hasMissingProductCosts = pricing.items.some(
    (item) => item.unitsSoldInWindow > 0 && item.recipeStatus !== "READY",
  );
  const economics =
    pricing.business.monthlyRevenueCents > 0 &&
    pricing.business.processingFeesStatus !== "missing" &&
    !hasMissingProductCosts
      ? businessEconomics({
          monthlyRevenueCents: pricing.business.monthlyRevenueCents,
          monthlyVariableProductCostCents: pricing.business.monthlyVariableProductCostCents,
          monthlyStaffCostCents: pricing.business.monthlyStaffCostCents,
          monthlyOperatingCostCents: pricing.business.monthlyOperatingCostCents,
          monthlyProcessingFeesCents: pricing.business.monthlyProcessingFeesCents,
        })
      : null;

  return {
    targetOperatingMargin: Number(business?.target_operating_margin ?? 0.15),
    targetOperatingMarginStatus: business?.target_operating_margin_status ?? "default",
    payrollTaxRate: Number(business?.payroll_tax_rate ?? 0.12),
    payrollTaxRateStatus: business?.payroll_tax_rate_status ?? "estimated",
    currentOperatingMargin: economics?.operatingMargin ?? null,
    currentMarginQuality:
      !economics
        ? "missing"
        : pricing.business.processingFeesStatus === "estimated" ||
            pricing.business.payrollCostsStatus === "estimated" ||
            pricing.business.operatingCostsStatus === "estimated"
          ? "estimated"
          : "actual",
    pricing,
  };
}
