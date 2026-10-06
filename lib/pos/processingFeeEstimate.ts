export type ProcessingFeeRateRule = {
  id: string;
  label: string;
  percentageBps: number;
  fixedFeeCents: number;
  /** Share of processed/card sales volume represented by this rule. */
  salesMixBps: number;
  /** Share of processed/card transactions represented by this rule. */
  transactionMixBps: number;
};

export type OwnerConfirmedProcessingFeePlan = {
  id: string;
  businessId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  processorLabel: string;
  processedSalesShareBps: number;
  processedTransactionShareBps: number;
  /** Used only when trustworthy real transaction counts are unavailable. */
  averageProcessedTicketCents: number | null;
  rules: ProcessingFeeRateRule[];
};

export type ProcessingFeeEstimate = {
  amountCents: number;
  percentageFeeCents: number;
  fixedFeeCents: number;
  estimatedProcessedSalesCents: number;
  estimatedProcessedTransactions: number;
  transactionCountSource: "trusted_orders" | "average_ticket" | "not_needed";
};

export type ProcessingFeeOrderEvidence = {
  posOrderId: string;
  netSalesCents: number;
  processingFeeProvider: string | null;
};

function validBps(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

export function validateOwnerConfirmedProcessingFeePlan(
  plan: Pick<
    OwnerConfirmedProcessingFeePlan,
    "processedSalesShareBps" | "processedTransactionShareBps" | "averageProcessedTicketCents" | "rules"
  >,
): string | null {
  if (!validBps(plan.processedSalesShareBps) || !validBps(plan.processedTransactionShareBps)) {
    return "Processing shares must be between 0% and 100%.";
  }
  if (plan.averageProcessedTicketCents !== null && (!Number.isInteger(plan.averageProcessedTicketCents) || plan.averageProcessedTicketCents <= 0)) {
    return "Average processed ticket must be a positive amount.";
  }
  if (plan.rules.length === 0) return "Add at least one processing-fee rule.";

  for (const rule of plan.rules) {
    if (!rule.label.trim()) return "Every processing-fee rule needs a label.";
    if (!Number.isInteger(rule.percentageBps) || rule.percentageBps < 0 || rule.percentageBps > 5_000) {
      return "Percentage fees must be between 0% and 50%.";
    }
    if (!Number.isInteger(rule.fixedFeeCents) || rule.fixedFeeCents < 0 || rule.fixedFeeCents > 5_000) {
      return "Fixed fees must be between $0 and $50 per transaction.";
    }
    if (!validBps(rule.salesMixBps) || !validBps(rule.transactionMixBps)) {
      return "Rule mix shares must be between 0% and 100%.";
    }
  }

  const salesMix = plan.rules.reduce((sum, rule) => sum + rule.salesMixBps, 0);
  if (plan.processedSalesShareBps > 0 && salesMix !== 10_000) {
    return "Sales mix must total 100%.";
  }

  const hasFixedFees = plan.rules.some((rule) => rule.fixedFeeCents > 0);
  const transactionMix = plan.rules.reduce((sum, rule) => sum + rule.transactionMixBps, 0);
  if (hasFixedFees && plan.processedTransactionShareBps > 0 && transactionMix !== 10_000) {
    return "Transaction mix must total 100%.";
  }

  return null;
}

/**
 * Returns a real transaction count only when the entire day's order set is provider-attributed,
 * non-synthetic, and exactly reconciles to the daily net-sales amount. Product/day CSV imports
 * intentionally create one synthetic order per item and therefore can never satisfy this test.
 */
export function trustedOrderCountForProcessingFeeEstimate(
  orders: ProcessingFeeOrderEvidence[],
  dailyNetSalesCents: number,
): number | null {
  if (orders.length === 0) return null;
  if (
    orders.some(
      (order) =>
        !order.processingFeeProvider ||
        order.processingFeeProvider === "csv" ||
        order.posOrderId.startsWith("csv-"),
    )
  ) {
    return null;
  }
  const reconciledSales = orders.reduce((sum, order) => sum + order.netSalesCents, 0);
  return reconciledSales === dailyNetSalesCents ? orders.length : null;
}

/**
 * Deterministic owner-confirmed fallback:
 * - percentage fees use the owner's processed-sales share and rule sales mix;
 * - fixed fees use trustworthy POS transaction counts when available;
 * - otherwise fixed fees require an explicit average processed ticket assumption.
 */
export function estimateOwnerConfirmedProcessingFee(params: {
  netSalesCents: number;
  trustedOrderCount: number | null;
  plan: OwnerConfirmedProcessingFeePlan;
}): ProcessingFeeEstimate | null {
  const { netSalesCents, trustedOrderCount, plan } = params;
  const validationError = validateOwnerConfirmedProcessingFeePlan(plan);
  if (validationError) return null;
  if (!Number.isFinite(netSalesCents) || netSalesCents < 0) return null;

  const estimatedProcessedSalesCents = (netSalesCents * plan.processedSalesShareBps) / 10_000;
  const percentageFeeCents = plan.rules.reduce(
    (sum, rule) =>
      sum +
      estimatedProcessedSalesCents *
        (rule.salesMixBps / 10_000) *
        (rule.percentageBps / 10_000),
    0,
  );

  const hasFixedFees = plan.rules.some((rule) => rule.fixedFeeCents > 0);
  let estimatedProcessedTransactions = 0;
  let transactionCountSource: ProcessingFeeEstimate["transactionCountSource"] = "not_needed";

  if (hasFixedFees && plan.processedTransactionShareBps > 0) {
    if (trustedOrderCount !== null) {
      estimatedProcessedTransactions = trustedOrderCount * (plan.processedTransactionShareBps / 10_000);
      transactionCountSource = "trusted_orders";
    } else if (plan.averageProcessedTicketCents) {
      estimatedProcessedTransactions = estimatedProcessedSalesCents / plan.averageProcessedTicketCents;
      transactionCountSource = "average_ticket";
    } else {
      // Never invent a transaction count for a fixed per-transaction fee.
      return null;
    }
  }

  const fixedFeeCents = plan.rules.reduce(
    (sum, rule) =>
      sum +
      estimatedProcessedTransactions *
        (rule.transactionMixBps / 10_000) *
        rule.fixedFeeCents,
    0,
  );

  return {
    amountCents: Math.round(percentageFeeCents + fixedFeeCents),
    percentageFeeCents: Math.round(percentageFeeCents),
    fixedFeeCents: Math.round(fixedFeeCents),
    estimatedProcessedSalesCents: Math.round(estimatedProcessedSalesCents),
    estimatedProcessedTransactions,
    transactionCountSource,
  };
}

export function processingFeePlanAppliesOn(
  plan: Pick<OwnerConfirmedProcessingFeePlan, "effectiveFrom" | "effectiveTo">,
  date: string,
): boolean {
  return plan.effectiveFrom <= date && (!plan.effectiveTo || plan.effectiveTo >= date);
}
