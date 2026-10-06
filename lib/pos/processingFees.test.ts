import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  connectedActualFactFromOrders,
  processingFeeForRollup,
  selectProcessingFeeDailyFact,
  setProcessingFeeCandidateEligibility,
  upsertProcessingFeeDailyFact,
  type ProcessingFeeDailyCandidate,
} from "./processingFees";

const candidate = (overrides: Partial<ProcessingFeeDailyCandidate> = {}): ProcessingFeeDailyCandidate => ({
  businessId: "cafe",
  businessDate: "2026-10-01",
  amountCents: 8_200,
  status: "actual",
  sourceType: "manual_actual",
  provider: "manual",
  eligible: true,
  updatedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("canonical processing-fee candidate selection", () => {
  it("distinguishes actual zero from missing zero", () => {
    expect(processingFeeForRollup({ amountCents: 0, status: "actual" })).toEqual({ amountCents: 0, status: "actual" });
    expect(processingFeeForRollup(null)).toEqual({ amountCents: 0, status: "missing" });
  });

  it("selects manual actual when no higher source exists", () => {
    expect(selectProcessingFeeDailyFact([candidate()])).toMatchObject({ sourceType: "manual_actual", amountCents: 8_200 });
  });

  it("selects connected actual over a preserved manual candidate", () => {
    expect(selectProcessingFeeDailyFact([
      candidate(),
      candidate({ sourceType: "connected_pos_actual", provider: "square", amountCents: 8_172 }),
    ])).toMatchObject({ sourceType: "connected_pos_actual", provider: "square", amountCents: 8_172 });
  });

  it("falls back to manual actual when connected actual becomes ineligible", () => {
    expect(selectProcessingFeeDailyFact([
      candidate(),
      candidate({ sourceType: "connected_pos_actual", provider: "square", amountCents: 8_172, eligible: false }),
    ])).toMatchObject({ sourceType: "manual_actual", amountCents: 8_200 });
  });

  it("returns missing when the only candidate becomes ineligible", () => {
    expect(selectProcessingFeeDailyFact([
      candidate({ sourceType: "connected_pos_actual", provider: "square", eligible: false }),
    ])).toBeNull();
  });

  it("selects connected actual again when it becomes eligible", () => {
    const connected = candidate({ sourceType: "connected_pos_actual", provider: "square", amountCents: 8_172 });
    expect(selectProcessingFeeDailyFact([candidate(), { ...connected, eligible: false }])?.sourceType).toBe("manual_actual");
    expect(selectProcessingFeeDailyFact([candidate(), connected])?.sourceType).toBe("connected_pos_actual");
  });

  it("falls back to an owner-confirmed estimate when actual candidates are unavailable", () => {
    expect(selectProcessingFeeDailyFact([
      candidate({ eligible: false }),
      candidate({ sourceType: "owner_confirmed_estimate", status: "estimated", provider: "owner", amountCents: 7_900 }),
    ])).toMatchObject({ sourceType: "owner_confirmed_estimate", status: "estimated", amountCents: 7_900 });
  });

  it("never stacks an estimate with actual", () => {
    expect(selectProcessingFeeDailyFact([
      candidate({ sourceType: "owner_confirmed_estimate", status: "estimated", provider: "owner", amountCents: 7_900 }),
      candidate({ amountCents: 8_200 }),
    ])?.amountCents).toBe(8_200);
  });

  it("builds a connected daily total only when every applicable order is actual", () => {
    expect(connectedActualFactFromOrders([
      { processingFeeCents: 44, processingFeeStatus: "actual" },
      { processingFeeCents: 31, processingFeeStatus: "actual" },
    ], { businessId: "cafe", businessDate: "2026-10-02", provider: "square" })).toMatchObject({
      amountCents: 75, status: "actual", sourceType: "connected_pos_actual",
    });
    expect(connectedActualFactFromOrders([
      { processingFeeCents: 44, processingFeeStatus: "actual" },
      { processingFeeCents: 0, processingFeeStatus: "missing" },
    ], { businessId: "cafe", businessDate: "2026-10-02", provider: "square" })).toBeNull();
  });

  it("writes candidates through the canonical candidate RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      business_id: "cafe", business_date: "2026-10-01", amount_cents: 8_172,
      status: "actual", source_type: "connected_pos_actual", provider: "toast",
      source_reference: "toast:payout-1", metadata: {},
    }, error: null });
    const selected = await upsertProcessingFeeDailyFact({ rpc } as unknown as SupabaseClient, {
      businessId: "cafe", businessDate: "2026-10-01", amountCents: 8_172,
      status: "actual", sourceType: "connected_pos_actual", provider: "toast",
      sourceReference: "toast:payout-1",
    });
    expect(rpc).toHaveBeenCalledWith("upsert_processing_fee_daily_candidate", expect.objectContaining({
      p_amount_cents: 8_172, p_source_type: "connected_pos_actual", p_provider: "toast",
    }));
    expect(selected).toMatchObject({ amountCents: 8_172, provider: "toast", status: "actual" });
  });

  it("invalidates a candidate and accepts a null selected fallback", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const selected = await setProcessingFeeCandidateEligibility({ rpc } as unknown as SupabaseClient, {
      businessId: "cafe", businessDate: "2026-10-01",
      sourceType: "connected_pos_actual", provider: "square", eligible: false,
    });
    expect(rpc).toHaveBeenCalledWith("set_processing_fee_candidate_eligibility", expect.objectContaining({
      p_source_type: "connected_pos_actual", p_provider: "square", p_eligible: false,
    }));
    expect(selected).toBeNull();
  });
});
