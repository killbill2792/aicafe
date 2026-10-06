import { describe, expect, it } from "vitest";
import {
  estimateOwnerConfirmedProcessingFee,
  trustedOrderCountForProcessingFeeEstimate,
  validateOwnerConfirmedProcessingFeePlan,
  type OwnerConfirmedProcessingFeePlan,
} from "./processingFeeEstimate";

function plan(overrides: Partial<OwnerConfirmedProcessingFeePlan> = {}): OwnerConfirmedProcessingFeePlan {
  return {
    id: "plan-1",
    businessId: "business-1",
    effectiveFrom: "2026-10-01",
    effectiveTo: null,
    processorLabel: "Processor",
    processedSalesShareBps: 10_000,
    processedTransactionShareBps: 10_000,
    averageProcessedTicketCents: 1_000,
    rules: [
      {
        id: "rule-1",
        label: "Card present",
        percentageBps: 249,
        fixedFeeCents: 15,
        salesMixBps: 10_000,
        transactionMixBps: 10_000,
      },
    ],
    ...overrides,
  };
}

describe("owner-confirmed processing-fee estimate", () => {
  it("calculates 2.49% + $0.15 using trustworthy transaction count", () => {
    expect(
      estimateOwnerConfirmedProcessingFee({
        netSalesCents: 10_000,
        trustedOrderCount: 10,
        plan: plan(),
      }),
    ).toMatchObject({
      amountCents: 399,
      percentageFeeCents: 249,
      fixedFeeCents: 150,
      estimatedProcessedTransactions: 10,
      transactionCountSource: "trusted_orders",
    });
  });

  it("uses separate weighted sales and transaction mixes", () => {
    const mixed = plan({
      rules: [
        {
          id: "present",
          label: "Card present",
          percentageBps: 249,
          fixedFeeCents: 15,
          salesMixBps: 7_000,
          transactionMixBps: 8_000,
        },
        {
          id: "other",
          label: "CNP / AmEx",
          percentageBps: 350,
          fixedFeeCents: 15,
          salesMixBps: 3_000,
          transactionMixBps: 2_000,
        },
      ],
    });
    const result = estimateOwnerConfirmedProcessingFee({
      netSalesCents: 100_000,
      trustedOrderCount: 100,
      plan: mixed,
    });
    // Percentage = $24.90*.70 + $35.00*.30 = $27.93; fixed = 100 * $0.15 = $15.
    expect(result).toMatchObject({
      percentageFeeCents: 2_793,
      fixedFeeCents: 1_500,
      amountCents: 4_293,
    });
  });

  it("applies explicit processed-sales and processed-transaction shares", () => {
    const result = estimateOwnerConfirmedProcessingFee({
      netSalesCents: 10_000,
      trustedOrderCount: 10,
      plan: plan({ processedSalesShareBps: 8_000, processedTransactionShareBps: 7_000 }),
    });
    expect(result).toMatchObject({
      percentageFeeCents: 199,
      fixedFeeCents: 105,
      amountCents: 304,
      estimatedProcessedTransactions: 7,
    });
  });

  it("uses owner-confirmed average ticket only when trustworthy order count is unavailable", () => {
    const result = estimateOwnerConfirmedProcessingFee({
      netSalesCents: 10_000,
      trustedOrderCount: null,
      plan: plan({ averageProcessedTicketCents: 2_000 }),
    });
    expect(result).toMatchObject({
      percentageFeeCents: 249,
      fixedFeeCents: 75,
      amountCents: 324,
      estimatedProcessedTransactions: 5,
      transactionCountSource: "average_ticket",
    });
  });

  it("refuses to invent fixed-fee transaction counts", () => {
    expect(
      estimateOwnerConfirmedProcessingFee({
        netSalesCents: 10_000,
        trustedOrderCount: null,
        plan: plan({ averageProcessedTicketCents: null }),
      }),
    ).toBeNull();
  });

  it("does not need a transaction assumption for percentage-only plans", () => {
    const percentageOnly = plan({
      averageProcessedTicketCents: null,
      rules: [
        {
          id: "pct",
          label: "Percentage only",
          percentageBps: 300,
          fixedFeeCents: 0,
          salesMixBps: 10_000,
          transactionMixBps: 0,
        },
      ],
    });
    expect(
      estimateOwnerConfirmedProcessingFee({
        netSalesCents: 10_000,
        trustedOrderCount: null,
        plan: percentageOnly,
      }),
    ).toMatchObject({ amountCents: 300, fixedFeeCents: 0, transactionCountSource: "not_needed" });
  });

  it("rejects synthetic CSV product rows as transaction evidence", () => {
    expect(
      trustedOrderCountForProcessingFeeEstimate(
        [
          { posOrderId: "csv-2026-10-01-Latte", netSalesCents: 5_000, processingFeeProvider: "csv" },
          { posOrderId: "csv-2026-10-01-Mocha", netSalesCents: 5_000, processingFeeProvider: "csv" },
        ],
        10_000,
      ),
    ).toBeNull();
  });

  it("accepts provider-attributed orders only when sales reconcile exactly", () => {
    const orders = [
      { posOrderId: "SQ-1", netSalesCents: 4_000, processingFeeProvider: "square" },
      { posOrderId: "SQ-2", netSalesCents: 6_000, processingFeeProvider: "square" },
    ];
    expect(trustedOrderCountForProcessingFeeEstimate(orders, 10_000)).toBe(2);
    expect(trustedOrderCountForProcessingFeeEstimate(orders, 9_999)).toBeNull();
  });

  it("requires sales mix to total 100%", () => {
    expect(
      validateOwnerConfirmedProcessingFeePlan(
        plan({
          rules: [
            {
              id: "bad",
              label: "Bad mix",
              percentageBps: 249,
              fixedFeeCents: 15,
              salesMixBps: 9_000,
              transactionMixBps: 10_000,
            },
          ],
        }),
      ),
    ).toBe("Sales mix must total 100%.");
  });
});
