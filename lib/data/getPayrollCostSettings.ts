import "server-only";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";

export type PayrollCostSettings = {
  employerCostRate: number;
  fallbackStatus: "estimated" | "confirmed";
  fallbackSource: string;
  actualSources: string[];
};

export async function getPayrollCostSettings(): Promise<PayrollCostSettings> {
  // The Staff Rules screen is also rendered in fixture mode without Supabase.
  // Render a read-only estimated fallback; never try to connect or imply actual costs.
  if (!isSupabaseConfigured()) return {
    employerCostRate: 0.12,
    fallbackStatus: "estimated",
    fallbackSource: "system_estimate",
    actualSources: [],
  };
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in first.");

  const businessId=await getActiveBusinessId(user.id);
  const {data:member,error}=await supabase.from("memberships")
    .select("business_id,businesses(is_demo,timezone,payroll_tax_rate,payroll_tax_rate_status,payroll_tax_rate_source)")
    .eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
  if(error) throw error;
  const raw=member?.businesses as unknown as {timezone:string;payroll_tax_rate:number;payroll_tax_rate_status:"estimated"|"confirmed";payroll_tax_rate_source:string}|{timezone:string;payroll_tax_rate:number;payroll_tax_rate_status:"estimated"|"confirmed";payroll_tax_rate_source:string}[]|null|undefined;
  const business=Array.isArray(raw)?raw[0]:raw;
  if(!member||!business) throw new Error("Café not found.");
  const timezone = business?.timezone ?? "America/Los_Angeles";
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");

  const { data: actualRows, error: actualError } = await supabase
    .from("daily_rollups")
    .select("staff_tax_source")
    .eq("business_id", businessId)
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
