import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  estimateOwnerConfirmedProcessingFee,
  processingFeePlanAppliesOn,
  trustedOrderCountForProcessingFeeEstimate,
  type OwnerConfirmedProcessingFeePlan,
  type ProcessingFeeOrderEvidence,
  type ProcessingFeeRateRule,
} from "./processingFeeEstimate";
import { setProcessingFeeCandidateEligibility, upsertProcessingFeeDailyFact } from "./processingFees";

export const OWNER_CONFIRMED_ESTIMATE_PROVIDER = "owner_confirmed";

type RatePlanRow = {
  id: string;
  business_id: string;
  effective_from: string;
  effective_to: string | null;
  processor_label: string;
  processed_sales_share_bps: number;
  processed_transaction_share_bps: number;
  average_processed_ticket_cents: number | null;
  rules: unknown;
};

type RollupRefreshRow = {
  business_date: string;
  net_sales_cents: number;
  orders_count: number;
  drinks_count: number;
  ingredients_cents: number;
  staff_wages_cents: number;
  staff_tax_cents: number;
  card_fees_cents: number;
  card_fees_status: "actual" | "estimated" | "missing";
  voids_cents: number;
};

function parseRules(value: unknown): ProcessingFeeRateRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const rule: ProcessingFeeRateRule = {
      id: String(row.id ?? ""),
      label: String(row.label ?? ""),
      percentageBps: Number(row.percentageBps),
      fixedFeeCents: Number(row.fixedFeeCents),
      salesMixBps: Number(row.salesMixBps),
      transactionMixBps: Number(row.transactionMixBps),
    };
    return [rule];
  });
}

export function ownerConfirmedProcessingFeePlanFromRow(row: RatePlanRow): OwnerConfirmedProcessingFeePlan {
  return {
    id: row.id,
    businessId: row.business_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    processorLabel: row.processor_label,
    processedSalesShareBps: Number(row.processed_sales_share_bps),
    processedTransactionShareBps: Number(row.processed_transaction_share_bps),
    averageProcessedTicketCents:
      row.average_processed_ticket_cents === null ? null : Number(row.average_processed_ticket_cents),
    rules: parseRules(row.rules),
  };
}

export async function getOwnerConfirmedProcessingFeePlans(
  supabase: SupabaseClient,
  businessId: string,
): Promise<OwnerConfirmedProcessingFeePlan[]> {
  const { data, error } = await supabase
    .from("processing_fee_rate_plans")
    .select(
      "id, business_id, effective_from, effective_to, processor_label, processed_sales_share_bps, processed_transaction_share_bps, average_processed_ticket_cents, rules",
    )
    .eq("business_id", businessId)
    .order("effective_from", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as RatePlanRow[]).map(ownerConfirmedProcessingFeePlanFromRow);
}

export function ownerConfirmedPlanForDate(
  plans: OwnerConfirmedProcessingFeePlan[],
  date: string,
): OwnerConfirmedProcessingFeePlan | null {
  return (
    [...plans]
      .filter((plan) => processingFeePlanAppliesOn(plan, date))
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? null
  );
}

async function persistEstimateForDay(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    businessDate: string;
    netSalesCents: number;
    orders: ProcessingFeeOrderEvidence[];
    plan: OwnerConfirmedProcessingFeePlan | null;
  },
): Promise<"estimated" | "missing"> {
  const { businessId, businessDate, netSalesCents, orders, plan } = params;
  if (!plan || netSalesCents <= 0) {
    await setProcessingFeeCandidateEligibility(supabase, {
      businessId,
      businessDate,
      sourceType: "owner_confirmed_estimate",
      provider: OWNER_CONFIRMED_ESTIMATE_PROVIDER,
      eligible: false,
    });
    return "missing";
  }

  const trustedOrderCount = trustedOrderCountForProcessingFeeEstimate(orders, netSalesCents);
  const estimate = estimateOwnerConfirmedProcessingFee({ netSalesCents, trustedOrderCount, plan });
  if (!estimate) {
    await setProcessingFeeCandidateEligibility(supabase, {
      businessId,
      businessDate,
      sourceType: "owner_confirmed_estimate",
      provider: OWNER_CONFIRMED_ESTIMATE_PROVIDER,
      eligible: false,
    });
    return "missing";
  }

  await upsertProcessingFeeDailyFact(supabase, {
    businessId,
    businessDate,
    amountCents: estimate.amountCents,
    status: "estimated",
    sourceType: "owner_confirmed_estimate",
    provider: OWNER_CONFIRMED_ESTIMATE_PROVIDER,
    sourceReference: `processing-rate-plan:${plan.id}`,
    metadata: {
      planId: plan.id,
      processorLabel: plan.processorLabel,
      transactionCountSource: estimate.transactionCountSource,
      estimatedProcessedSalesCents: estimate.estimatedProcessedSalesCents,
      estimatedProcessedTransactions: Number(estimate.estimatedProcessedTransactions.toFixed(4)),
      percentageFeeCents: estimate.percentageFeeCents,
      fixedFeeCents: estimate.fixedFeeCents,
    },
  });
  return "estimated";
}

/**
 * Ensures the lower-priority owner-confirmed candidate for one day is current before rollup
 * selection. Connected/manual actuals still win in processing_fee_daily_facts and are never added
 * to this estimate.
 */
export async function ensureOwnerConfirmedProcessingFeeEstimateForDay(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    businessDate: string;
    netSalesCents: number;
    orders: ProcessingFeeOrderEvidence[];
  },
): Promise<void> {
  const { businessId, businessDate } = params;
  const { data, error } = await supabase
    .from("processing_fee_rate_plans")
    .select(
      "id, business_id, effective_from, effective_to, processor_label, processed_sales_share_bps, processed_transaction_share_bps, average_processed_ticket_cents, rules",
    )
    .eq("business_id", businessId)
    .lte("effective_from", businessDate)
    .or(`effective_to.is.null,effective_to.gte.${businessDate}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const plan = data ? ownerConfirmedProcessingFeePlanFromRow(data as RatePlanRow) : null;
  await persistEstimateForDay(supabase, { ...params, plan });
}

async function runInChunks<T>(
  values: T[],
  size: number,
  task: (value: T) => Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < values.length; index += size) {
    await Promise.all(values.slice(index, index + size).map(task));
  }
}

export type ProcessingFeeEstimateRefreshSummary = {
  salesDays: number;
  actualDays: number;
  estimatedDays: number;
  missingDays: number;
};

/**
 * Rebuilds owner-confirmed fallback candidates for an existing history window, then projects the
 * canonical selected facts back into daily_rollups. This makes a newly confirmed rate plan useful
 * to pricing immediately without touching sales, orders, recipes, labor, or actual fee facts.
 */
export async function refreshOwnerConfirmedProcessingFeeEstimates(
  supabase: SupabaseClient,
  params: { businessId: string; fromDate: string; toDate: string },
): Promise<ProcessingFeeEstimateRefreshSummary> {
  const { businessId, fromDate, toDate } = params;
  const [plans, rollupsResult, ordersResult] = await Promise.all([
    getOwnerConfirmedProcessingFeePlans(supabase, businessId),
    supabase
      .from("daily_rollups")
      .select(
        "business_date, net_sales_cents, orders_count, drinks_count, ingredients_cents, staff_wages_cents, staff_tax_cents, card_fees_cents, card_fees_status, voids_cents",
      )
      .eq("business_id", businessId)
      .gte("business_date", fromDate)
      .lte("business_date", toDate)
      .order("business_date", { ascending: true }),
    supabase
      .from("orders")
      .select("business_date, pos_order_id, net_sales_cents, processing_fee_provider")
      .eq("business_id", businessId)
      .gte("business_date", fromDate)
      .lte("business_date", toDate),
  ]);
  if (rollupsResult.error) throw rollupsResult.error;
  if (ordersResult.error) throw ordersResult.error;

  const rollups = (rollupsResult.data ?? []) as RollupRefreshRow[];
  const ordersByDate = new Map<string, ProcessingFeeOrderEvidence[]>();
  for (const order of ordersResult.data ?? []) {
    const evidence: ProcessingFeeOrderEvidence = {
      posOrderId: order.pos_order_id,
      netSalesCents: Number(order.net_sales_cents),
      processingFeeProvider: order.processing_fee_provider,
    };
    const rows = ordersByDate.get(order.business_date) ?? [];
    rows.push(evidence);
    ordersByDate.set(order.business_date, rows);
  }

  await runInChunks(rollups, 10, async (rollup) => {
    const plan = ownerConfirmedPlanForDate(plans, rollup.business_date);
    await persistEstimateForDay(supabase, {
      businessId,
      businessDate: rollup.business_date,
      netSalesCents: Number(rollup.net_sales_cents),
      orders: ordersByDate.get(rollup.business_date) ?? [],
      plan,
    });
  });

  const { data: selectedFacts, error: selectedError } = await supabase
    .from("processing_fee_daily_facts")
    .select("business_date, amount_cents, status")
    .eq("business_id", businessId)
    .gte("business_date", fromDate)
    .lte("business_date", toDate);
  if (selectedError) throw selectedError;
  const selectedByDate = new Map(
    (selectedFacts ?? []).map((fact) => [
      fact.business_date,
      { amountCents: Number(fact.amount_cents), status: fact.status as "actual" | "estimated" },
    ]),
  );

  if (rollups.length > 0) {
    const { error: rollupWriteError } = await supabase.from("daily_rollups").upsert(
      rollups.map((rollup) => {
        const selected = selectedByDate.get(rollup.business_date);
        return {
          business_id: businessId,
          business_date: rollup.business_date,
          net_sales_cents: rollup.net_sales_cents,
          orders_count: rollup.orders_count,
          drinks_count: rollup.drinks_count,
          ingredients_cents: rollup.ingredients_cents,
          staff_wages_cents: rollup.staff_wages_cents,
          staff_tax_cents: rollup.staff_tax_cents,
          card_fees_cents: selected?.amountCents ?? 0,
          card_fees_status: selected?.status ?? "missing",
          voids_cents: rollup.voids_cents,
        };
      }),
      { onConflict: "business_id,business_date" },
    );
    if (rollupWriteError) throw rollupWriteError;
  }

  const salesDays = rollups.filter((row) => Number(row.net_sales_cents) > 0);
  let actualDays = 0;
  let estimatedDays = 0;
  let missingDays = 0;
  for (const row of salesDays) {
    const selected = selectedByDate.get(row.business_date);
    if (selected?.status === "actual") actualDays += 1;
    else if (selected?.status === "estimated") estimatedDays += 1;
    else missingDays += 1;
  }

  return { salesDays: salesDays.length, actualDays, estimatedDays, missingDays };
}
