"use server";

import { revalidatePath } from "next/cache";
import { subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import {
  validateOwnerConfirmedProcessingFeePlan,
  type OwnerConfirmedProcessingFeePlan,
} from "@/lib/pos/processingFeeEstimate";
import { refreshOwnerConfirmedProcessingFeeEstimates } from "@/lib/pos/processingFeeEstimate.server";

const RateRuleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(100),
  percentageBps: z.number().int().min(0).max(5_000),
  fixedFeeCents: z.number().int().min(0).max(5_000),
  salesMixBps: z.number().int().min(0).max(10_000),
  transactionMixBps: z.number().int().min(0).max(10_000),
});

const PlanSchema = z.object({
  processorLabel: z.string().trim().min(1).max(80),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  processedSalesShareBps: z.number().int().min(0).max(10_000),
  processedTransactionShareBps: z.number().int().min(0).max(10_000),
  averageProcessedTicketCents: z.number().int().positive().nullable(),
  rules: z.array(RateRuleSchema).min(1).max(8),
});

export type SaveProcessingFeeEstimateResult =
  | {
      ok: true;
      summary: { salesDays: number; actualDays: number; estimatedDays: number; missingDays: number };
    }
  | { ok: false; error: string };

function dayBefore(date: string): string {
  return formatInTimeZone(subDays(new Date(`${date}T12:00:00Z`), 1), "UTC", "yyyy-MM-dd");
}

async function ownBusinessContext() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("business_id, businesses(is_demo, timezone)")
    .eq("user_id", user.id);
  if (error) throw error;

  const own = (memberships ?? []).find((membership) => {
    const raw = membership.businesses as unknown as
      | { is_demo: boolean; timezone: string }
      | { is_demo: boolean; timezone: string }[]
      | null;
    const business = Array.isArray(raw) ? raw[0] : raw;
    return business?.is_demo === false;
  });
  if (!own || own.business_id === DEMO_BUSINESS_ID) return null;

  const raw = own.businesses as unknown as
    | { is_demo: boolean; timezone: string }
    | { is_demo: boolean; timezone: string }[];
  const business = Array.isArray(raw) ? raw[0] : raw;
  return { supabase, userId: user.id, businessId: own.business_id, timezone: business?.timezone ?? "America/Los_Angeles" };
}

export async function saveOwnerProcessingFeeEstimatePlan(input: unknown): Promise<SaveProcessingFeeEstimateResult> {
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the processor rates and payment mix." };

  let ctx: Awaited<ReturnType<typeof ownBusinessContext>>;
  try {
    ctx = await ownBusinessContext();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load your café." };
  }
  if (!ctx) return { ok: false, error: "Set up your own café first." };

  const inputPlan = parsed.data;
  const validationPlan: OwnerConfirmedProcessingFeePlan = {
    id: "validation",
    businessId: ctx.businessId,
    effectiveFrom: inputPlan.effectiveFrom,
    effectiveTo: null,
    processorLabel: inputPlan.processorLabel,
    processedSalesShareBps: inputPlan.processedSalesShareBps,
    processedTransactionShareBps: inputPlan.processedTransactionShareBps,
    averageProcessedTicketCents: inputPlan.averageProcessedTicketCents,
    rules: inputPlan.rules,
  };
  const validationError = validateOwnerConfirmedProcessingFeePlan(validationPlan);
  if (validationError) return { ok: false, error: validationError };

  const nowIso = new Date().toISOString();
  const { error: upsertError } = await ctx.supabase.from("processing_fee_rate_plans").upsert(
    {
      business_id: ctx.businessId,
      effective_from: inputPlan.effectiveFrom,
      effective_to: null,
      processor_label: inputPlan.processorLabel,
      processed_sales_share_bps: inputPlan.processedSalesShareBps,
      processed_transaction_share_bps: inputPlan.processedTransactionShareBps,
      average_processed_ticket_cents: inputPlan.averageProcessedTicketCents,
      rules: inputPlan.rules,
      confirmed_by: ctx.userId,
      confirmed_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "business_id,effective_from" },
  );
  if (upsertError) return { ok: false, error: upsertError.message };

  // Normalize plan windows deterministically so historical rate changes remain auditable.
  const { data: planRows, error: planRowsError } = await ctx.supabase
    .from("processing_fee_rate_plans")
    .select("id, effective_from, effective_to")
    .eq("business_id", ctx.businessId)
    .order("effective_from", { ascending: true });
  if (planRowsError) return { ok: false, error: planRowsError.message };

  for (let index = 0; index < (planRows ?? []).length; index += 1) {
    const row = planRows![index];
    const next = planRows![index + 1];
    const expectedEnd = next ? dayBefore(next.effective_from) : null;
    if (row.effective_to === expectedEnd) continue;
    const { error } = await ctx.supabase
      .from("processing_fee_rate_plans")
      .update({ effective_to: expectedEnd, updated_at: nowIso })
      .eq("id", row.id)
      .eq("business_id", ctx.businessId);
    if (error) return { ok: false, error: error.message };
  }

  const today = formatInTimeZone(new Date(), ctx.timezone, "yyyy-MM-dd");
  const fromDate = formatInTimeZone(subDays(new Date(`${today}T12:00:00Z`), 89), "UTC", "yyyy-MM-dd");

  let summary;
  try {
    summary = await refreshOwnerConfirmedProcessingFeeEstimates(ctx.supabase, {
      businessId: ctx.businessId,
      fromDate,
      toDate: today,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not refresh processing-fee estimates." };
  }

  revalidatePath("/");
  revalidatePath("/menu");
  revalidatePath("/operations");
  revalidatePath("/money");
  revalidatePath("/more");
  revalidatePath("/more/processing-fees");
  return { ok: true, summary };
}
