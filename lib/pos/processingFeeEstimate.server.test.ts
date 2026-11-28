import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { refreshOwnerConfirmedProcessingFeeEstimates } from "./processingFeeEstimate.server";
import { upsertProcessingFeeDailyFact } from "./processingFees";

vi.mock("server-only", () => ({}));
vi.mock("./processingFees", () => ({
  setProcessingFeeCandidateEligibility: vi.fn(),
  upsertProcessingFeeDailyFact: vi.fn(),
}));

describe("refreshOwnerConfirmedProcessingFeeEstimates", () => {
  it("uses all canonical orders and preserves the selected actual fee", async () => {
    const businessId = "cafe";
    const businessDate = "2026-10-21";
    const orders = Array.from({ length: 1001 }, (_, index) => ({
      business_date: businessDate,
      pos_order_id: `toast:restaurant:${index}`,
      net_sales_cents: 100,
      processing_fee_provider: "toast",
    }));
    const canonical = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn(async (first: number, last: number) => ({ data: orders.slice(first, last + 1), error: null })),
    };
    const netSalesCents = orders.length * 100;
    const rollups = {
      data: [{ business_date: businessDate, net_sales_cents: netSalesCents, orders_count: orders.length }],
      error: null,
    };
    const selected = { data: [{ business_date: businessDate, amount_cents: 2800, status: "actual" }], error: null };
    const writeRollup = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: (table: string) => {
        const base = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis() };
        switch (table) {
          case "cv_orders": return canonical;
          case "processing_fee_rate_plans": return {
            ...base,
            order: async () => ({ data: [{
              id: "plan", business_id: businessId, effective_from: businessDate, effective_to: null,
              processor_label: "Processor", processed_sales_share_bps: 10_000,
              processed_transaction_share_bps: 10_000, average_processed_ticket_cents: null,
              rules: [{ id: "card", label: "Card", percentageBps: 250, fixedFeeCents: 15,
                salesMixBps: 10_000, transactionMixBps: 10_000 }],
            }], error: null }),
          };
          case "daily_rollups": return { ...base, lte: () => ({ order: async () => rollups }), upsert: writeRollup };
          case "processing_fee_daily_facts": return { ...base, lte: async () => selected };
          default: throw new Error(`Unexpected source ${table}`);
        }
      },
    } as unknown as SupabaseClient;

    await expect(refreshOwnerConfirmedProcessingFeeEstimates(db, {
      businessId, fromDate: businessDate, toDate: businessDate,
    })).resolves.toEqual({ salesDays: 1, actualDays: 1, estimatedDays: 0, missingDays: 0 });
    expect(canonical.eq.mock.calls).toEqual(canonical.range.mock.calls.flatMap(() => [
      ["business_id", businessId], ["status", "actual"],
    ]));
    expect(canonical.order).toHaveBeenCalledWith("order_ref");
    expect(canonical.range.mock.calls).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(upsertProcessingFeeDailyFact).toHaveBeenCalledWith(db, expect.objectContaining({
      sourceType: "owner_confirmed_estimate",
      metadata: expect.objectContaining({ transactionCountSource: "trusted_orders", estimatedProcessedTransactions: 1001 }),
    }));
    expect(writeRollup).toHaveBeenCalledWith(
      [expect.objectContaining({ card_fees_cents: 2800, card_fees_status: "actual" })],
      { onConflict: "business_id,business_date" },
    );
  });
});
