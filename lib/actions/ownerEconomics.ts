"use server";

import { revalidatePath } from "next/cache";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

const OwnerEconomicsSchema = z.object({
  targetOperatingMarginPercent: z.number().min(0).max(80),
  payrollBurdenPercent: z.number().min(0).max(100),
});

export type OwnerEconomicsActionResult =
  | { ok: true }
  | { ok: false; error: string };

async function ownBusinessContext() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("business_id, businesses(is_demo, timezone, payroll_tax_rate)")
    .eq("user_id", user.id);
  if (error) throw error;

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as
      | { is_demo: boolean; timezone: string; payroll_tax_rate: number }
      | { is_demo: boolean; timezone: string; payroll_tax_rate: number }[]
      | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own || own.business_id === DEMO_BUSINESS_ID) return null;

  const raw = own.businesses as unknown as
    | { is_demo: boolean; timezone: string; payroll_tax_rate: number }
    | { is_demo: boolean; timezone: string; payroll_tax_rate: number }[];
  const business = Array.isArray(raw) ? raw[0] : raw;
  return {
    supabase,
    businessId: own.business_id,
    timezone: business?.timezone ?? "America/Los_Angeles",
    currentPayrollRate: Number(business?.payroll_tax_rate ?? 0.12),
  };
}

async function refreshEstimatedPayrollBurden(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  businessId: string,
  timezone: string,
  payrollRate: number,
) {
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");
  const { data: rows, error } = await supabase
    .from("daily_rollups")
    .select("business_date, staff_wages_cents, staff_tax_status")
    .eq("business_id", businessId)
    .gte("business_date", fromDate)
    .lte("business_date", today);
  if (error) throw error;

  const estimatedRows = (rows ?? []).filter((row) => row.staff_tax_status !== "actual");
  for (let index = 0; index < estimatedRows.length; index += 10) {
    const chunk = estimatedRows.slice(index, index + 10);
    await Promise.all(
      chunk.map(async (row) => {
        const { error: updateError } = await supabase
          .from("daily_rollups")
          .update({
            staff_tax_cents: Math.round(Number(row.staff_wages_cents) * payrollRate),
            staff_tax_status: "estimated",
          })
          .eq("business_id", businessId)
          .eq("business_date", row.business_date);
        if (updateError) throw updateError;
      }),
    );
  }
}

export async function saveOwnerEconomicsSettings(input: unknown): Promise<OwnerEconomicsActionResult> {
  const parsed = OwnerEconomicsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the target margin and payroll burden." };

  let ctx: Awaited<ReturnType<typeof ownBusinessContext>>;
  try {
    ctx = await ownBusinessContext();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load your café." };
  }
  if (!ctx) return { ok: false, error: "Set up your own café first." };

  const targetOperatingMargin = parsed.data.targetOperatingMarginPercent / 100;
  const payrollTaxRate = parsed.data.payrollBurdenPercent / 100;

  const { error: businessError } = await ctx.supabase
    .from("businesses")
    .update({
      target_operating_margin: targetOperatingMargin,
      target_operating_margin_status: "confirmed",
      payroll_tax_rate: payrollTaxRate,
      payroll_tax_rate_status: "confirmed",
    })
    .eq("id", ctx.businessId);
  if (businessError) return { ok: false, error: businessError.message };

  if (Math.abs(ctx.currentPayrollRate - payrollTaxRate) > 0.000001) {
    try {
      await refreshEstimatedPayrollBurden(ctx.supabase, ctx.businessId, ctx.timezone, payrollTaxRate);
    } catch (error) {
      return {
        ok: false,
        error: `Settings were saved, but payroll estimates could not be refreshed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  for (const path of ["/", "/money", "/staff", "/menu", "/operations", "/more", "/more/economics"]) {
    revalidatePath(path);
  }
  return { ok: true };
}
