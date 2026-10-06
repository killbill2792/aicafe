import "server-only";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

export type PayrollCostSettings = {
  employerCostRate: number;
  fallbackStatus: "estimated" | "confirmed";
  fallbackSource: string;
  actualSources: string[];
};

export async function getPayrollCostSettings(): Promise<PayrollCostSettings> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in first.");

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select(
      "business_id, businesses(is_demo, timezone, payroll_tax_rate, payroll_tax_rate_status, payroll_tax_rate_source)",
    )
    .eq("user_id", user.id);
  if (error) throw error;

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as
      | {
          is_demo: boolean;
          timezone: string;
          payroll_tax_rate: number;
          payroll_tax_rate_status: "estimated" | "confirmed";
          payroll_tax_rate_source: string;
        }
      | {
          is_demo: boolean;
          timezone: string;
          payroll_tax_rate: number;
          payroll_tax_rate_status: "estimated" | "confirmed";
          payroll_tax_rate_source: string;
        }[]
      | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own || own.business_id === DEMO_BUSINESS_ID) throw new Error("Own café not found.");

  const raw = own.businesses as unknown as
    | {
        is_demo: boolean;
        timezone: string;
        payroll_tax_rate: number;
        payroll_tax_rate_status: "estimated" | "confirmed";
        payroll_tax_rate_source: string;
      }
    | {
        is_demo: boolean;
        timezone: string;
        payroll_tax_rate: number;
        payroll_tax_rate_status: "estimated" | "confirmed";
        payroll_tax_rate_source: string;
      }[];
  const business = Array.isArray(raw) ? raw[0] : raw;
  const timezone = business?.timezone ?? "America/Los_Angeles";
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");

  const { data: actualRows, error: actualError } = await supabase
    .from("daily_rollups")
    .select("staff_tax_source")
    .eq("business_id", own.business_id)
    .eq("staff_tax_status", "actual")
    .gte("business_date", fromDate)
    .lte("business_date", today);
  if (actualError) throw actualError;

  return {
    employerCostRate: Number(business?.payroll_tax_rate ?? 0.12),
    fallbackStatus: business?.payroll_tax_rate_status ?? "estimated",
    fallbackSource: business?.payroll_tax_rate_source ?? "system_estimate",
    actualSources: [...new Set((actualRows ?? []).map((row) => row.staff_tax_source).filter(Boolean))],
  };
}
