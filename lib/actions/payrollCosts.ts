"use server";

import { revalidatePath } from "next/cache";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";

const PayrollFallbackSchema = z.object({
  employerCostPercent: z.number().min(0).max(100),
});

export type PayrollFallbackResult = { ok: true; refreshed: boolean } | { ok: false; error: string };

async function ownBusinessContext() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const businessId = await getActiveBusinessId(user.id);
  if (businessId === DEMO_BUSINESS_ID) return null;
  const {data: member,error} = await supabase.from("memberships")
    .select("role,businesses(is_demo,timezone)").eq("user_id",user.id)
    .eq("business_id",businessId).eq("role","owner").maybeSingle();
  if(error) throw error;
  const raw=member?.businesses as unknown as {is_demo:boolean;timezone:string}|{is_demo:boolean;timezone:string}[]|null|undefined;
  const business=Array.isArray(raw)?raw[0]:raw;
  if(!member||business?.is_demo!==false) return null;
  return {supabase,businessId,timezone:business.timezone??"America/Los_Angeles"};
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
  const estimatedRows = (rows ?? []).filter((row) => row.staff_tax_status === "estimated" && row.staff_wages_cents !== null && Number.isSafeInteger(Number(row.staff_wages_cents)) && Number(row.staff_wages_cents) >= 0);
  let refreshed = true;
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
          .eq("business_date", row.business_date)
          .eq("staff_tax_status", "estimated")
          .eq("staff_wages_cents", row.staff_wages_cents)
          .select("business_date"),
      ),
    );
    if (results.some(result => result.error || result.data?.length !== 1)) refreshed = false;
  }

  for (const path of ["/staff", "/staff/rules", "/onboarding", "/", "/money", "/menu", "/operations"]) revalidatePath(path);
  return { ok: true, refreshed };
}
