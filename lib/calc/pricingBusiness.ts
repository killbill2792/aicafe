import type { BusinessAdjustmentResult, BusinessEconomicsInput, BusinessEconomicsResult } from "./types";

export function businessEconomics(input: BusinessEconomicsInput): BusinessEconomicsResult {
  const totalMonthlyCostCents = input.monthlyVariableProductCostCents + input.monthlyStaffCostCents + input.monthlyOperatingCostCents + input.monthlyProcessingFeesCents;
  const operatingSurplusCents = input.monthlyRevenueCents - totalMonthlyCostCents;
  return { totalMonthlyCostCents, operatingSurplusCents, operatingMargin: input.monthlyRevenueCents === 0 ? 0 : operatingSurplusCents / input.monthlyRevenueCents };
}

/** Normalizes actual processing fees observed over the pricing window to the same 30-day basis
 * as revenue, staff, and variable product cost. The read layer decides source precedence before
 * supplying daily canonical fees; this calculation deliberately knows nothing about providers. */
export function monthlyProcessingFeesForWindow(cardFeesCents: number[], windowDays: number): number {
  if (windowDays <= 0) return 0;
  return Math.round(cardFeesCents.reduce((sum, cents) => sum + cents, 0) * (30 / windowDays));
}

export function businessAdjustmentFactor(economics: BusinessEconomicsResult, monthlyRevenueCents: number, targetOperatingMargin: number, cap: number): BusinessAdjustmentResult {
  if (monthlyRevenueCents <= 0) return { businessAdjustmentFactor: 1, cappedForReview: false };
  const shortfall = monthlyRevenueCents * targetOperatingMargin - economics.operatingSurplusCents;
  if (shortfall <= 0) return { businessAdjustmentFactor: 1, cappedForReview: false };
  const rawFactor = (monthlyRevenueCents + shortfall) / monthlyRevenueCents;
  return { businessAdjustmentFactor: Math.min(rawFactor, cap), cappedForReview: rawFactor > cap };
}
