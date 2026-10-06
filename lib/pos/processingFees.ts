import type { SupabaseClient } from "@supabase/supabase-js";

export type ProcessingFeeStatus = "actual" | "estimated" | "missing";
export type ProcessingFeeSourceType =
  | "connected_pos_actual"
  | "manual_actual"
  | "owner_confirmed_estimate"
  | "temporary_estimate"
  | "missing";
export type ProcessingFeeCandidateSourceType = Exclude<ProcessingFeeSourceType, "missing">;

export type ProcessingFeeDailyFact = {
  businessId: string;
  businessDate: string;
  amountCents: number;
  status: ProcessingFeeStatus;
  sourceType: ProcessingFeeSourceType;
  provider: string;
  sourceReference?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export type ProcessingFeeDailyCandidate = Omit<ProcessingFeeDailyFact, "sourceType"> & {
  sourceType: ProcessingFeeCandidateSourceType;
  eligible: boolean;
  updatedAt?: string;
};

const SOURCE_PRIORITY: Record<ProcessingFeeCandidateSourceType, number> = {
  connected_pos_actual: 4,
  manual_actual: 3,
  owner_confirmed_estimate: 2,
  temporary_estimate: 1,
};

export function processingFeeStatusForSource(sourceType: ProcessingFeeSourceType): ProcessingFeeStatus {
  if (sourceType === "connected_pos_actual" || sourceType === "manual_actual") return "actual";
  if (sourceType === "owner_confirmed_estimate" || sourceType === "temporary_estimate") return "estimated";
  return "missing";
}

function validateCandidate(candidate: Pick<ProcessingFeeDailyCandidate, "amountCents" | "status" | "sourceType">): void {
  if (candidate.amountCents < 0 || !Number.isInteger(candidate.amountCents)) {
    throw new Error("Processing fee must be non-negative integer cents");
  }
  if (candidate.status !== processingFeeStatusForSource(candidate.sourceType)) {
    throw new Error("Processing fee status does not match its source");
  }
}

export function processingFeeForRollup(
  fact: Pick<ProcessingFeeDailyFact, "amountCents" | "status"> | null,
): { amountCents: number; status: ProcessingFeeStatus } {
  return fact ? { amountCents: fact.amountCents, status: fact.status } : { amountCents: 0, status: "missing" };
}

export function connectedActualFactFromOrders(
  orders: { processingFeeCents: number; processingFeeStatus: ProcessingFeeStatus }[],
  identity: Pick<ProcessingFeeDailyFact, "businessId" | "businessDate" | "provider">,
): ProcessingFeeDailyFact | null {
  if (orders.length === 0 || orders.some((order) => order.processingFeeStatus !== "actual")) return null;
  return {
    ...identity,
    amountCents: orders.reduce((sum, order) => sum + order.processingFeeCents, 0),
    status: "actual",
    sourceType: "connected_pos_actual",
    sourceReference: `pos-sync:${identity.provider}:${identity.businessDate}`,
  };
}

/** Pure mirror of the database selector, including fallback when a higher-priority source is ineligible. */
export function selectProcessingFeeDailyFact(candidates: ProcessingFeeDailyCandidate[]): ProcessingFeeDailyFact | null {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  for (const candidate of eligible) validateCandidate(candidate);
  const selected = [...eligible].sort((left, right) => {
    const priority = SOURCE_PRIORITY[right.sourceType] - SOURCE_PRIORITY[left.sourceType];
    if (priority !== 0) return priority;
    const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    if (updated !== 0) return updated;
    return left.provider.localeCompare(right.provider);
  })[0];
  if (!selected) return null;
  const { eligible: _eligible, updatedAt: _updatedAt, ...fact } = selected;
  return fact;
}

function rowToFact(row: Record<string, unknown> | null | undefined): ProcessingFeeDailyFact | null {
  if (!row) return null;
  return {
    businessId: String(row.business_id),
    businessDate: String(row.business_date),
    amountCents: Number(row.amount_cents),
    status: row.status as ProcessingFeeStatus,
    sourceType: row.source_type as ProcessingFeeSourceType,
    provider: String(row.provider),
    sourceReference: (row.source_reference as string | null | undefined) ?? null,
    metadata: (row.metadata as ProcessingFeeDailyFact["metadata"]) ?? {},
  };
}

/**
 * Single persistence boundary for Square, future Toast, manual reports, and future estimates.
 * The DB stores the candidate and re-selects the best eligible source atomically.
 */
export async function upsertProcessingFeeDailyFact(
  supabase: SupabaseClient,
  fact: ProcessingFeeDailyFact,
): Promise<ProcessingFeeDailyFact> {
  if (fact.sourceType === "missing") throw new Error("Missing processing fees are represented by no eligible candidate");
  validateCandidate({ ...fact, sourceType: fact.sourceType });
  const { data, error } = await supabase.rpc("upsert_processing_fee_daily_candidate", {
    p_business_id: fact.businessId,
    p_business_date: fact.businessDate,
    p_amount_cents: fact.amountCents,
    p_status: fact.status,
    p_source_type: fact.sourceType,
    p_provider: fact.provider,
    p_source_reference: fact.sourceReference ?? null,
    p_metadata: fact.metadata ?? {},
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const selected = rowToFact(row as Record<string, unknown> | null);
  if (!selected) throw new Error("Processing fee candidate did not produce a selected fact");
  return selected;
}

/** Marks one source/date usable or unusable, then returns the newly selected fallback (or null). */
export async function setProcessingFeeCandidateEligibility(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    businessDate: string;
    sourceType: ProcessingFeeCandidateSourceType;
    provider: string;
    eligible: boolean;
  },
): Promise<ProcessingFeeDailyFact | null> {
  const { data, error } = await supabase.rpc("set_processing_fee_candidate_eligibility", {
    p_business_id: input.businessId,
    p_business_date: input.businessDate,
    p_source_type: input.sourceType,
    p_provider: input.provider,
    p_eligible: input.eligible,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return rowToFact(row as Record<string, unknown> | null);
}

/** Square and future Toast call this same daily boundary after trustworthy fee data is complete. */
export async function writeConnectedPosActualProcessingFee(
  supabase: SupabaseClient,
  input: { businessId: string; businessDate: string; amountCents: number; provider: string; sourceReference?: string },
): Promise<ProcessingFeeDailyFact> {
  return upsertProcessingFeeDailyFact(supabase, {
    ...input,
    status: "actual",
    sourceType: "connected_pos_actual",
  });
}
