"use server";

import { revalidatePath } from "next/cache";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

const PayrollFallbackSchema = z.object({
  employerCostPercent: z.number().min(0).max(100),
});

export type PayrollFallbackResult = { ok: true } | { ok: false; error: string };

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
  };
}

export async function savePayrollCostAssumption(input: unknown): Promise<PayrollFallbackResult> {
  const parsed = PayrollFallbackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a percentage from 0% to 100%." };

  let ctx: Awaited<ReturnType<typeof ownBusinessContext>>;
  try {
    ctx = await ownBusinessContext();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load your café." };
  }
  if (!ctx) return { ok: false, error: "Set up your own café first." };

  const rate = parsed.data.employerCostPercent / 100;
  const { error: businessError } = await ctx.supabase
    .from("businesses")
    .update({
      payroll_tax_rate: rate,
      payroll_tax_rate_status: "confirmed",
      payroll_tax_rate_source: "owner_entered",
    })
    .eq("id", ctx.businessId);
  if (businessError) return { ok: false, error: businessError.message };

  const today = formatInTimeZone(new Date(), ctx.timezone, "yyyy-MM-dd");
  const fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");
  const { data: rows, error: rowsError } = await ctx.supabase
    .from("daily_rollups")
    .select("business_date, staff_wages_cents, staff_tax_status")
    .eq("business_id", ctx.businessId)
    .gte("business_date", fromDate)
    .lte("business_date", today);
  if (rowsError) return { ok: false, error: rowsError.message };

  // Only fallback/estimated days change. Connected/imported actual payroll is preserved.
  const estimatedRows = (rows ?? []).filter((row) => row.staff_tax_status !== "actual");
  for (let index = 0; index < estimatedRows.length; index += 10) {
    const chunk = estimatedRows.slice(index, index + 10);
    const results = await Promise.all(
      chunk.map((row) =>
        ctx!.supabase
          .from("daily_rollups")
          .update({
            staff_tax_cents: Math.round(Number(row.staff_wages_cents) * rate),
            staff_tax_status: "estimated",
            staff_tax_source: "owner_entered",
          })
          .eq("business_id", ctx!.businessId)
          .eq("business_date", row.business_date),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) return { ok: false, error: failed.error.message };
  }

  for (const path of ["/staff", "/", "/money", "/menu", "/operations"]) revalidatePath(path);
  return { ok: true };
}
