import type { BusinessAdjustmentResult, BusinessEconomicsInput, BusinessEconomicsResult } from "./types";

export function businessEconomics(input: BusinessEconomicsInput): BusinessEconomicsResult {
  const totalMonthlyCostCents = input.monthlyVariableProductCostCents + input.monthlyStaffCostCents + input.monthlyOperatingCostCents;
  const operatingSurplusCents = input.monthlyRevenueCents - totalMonthlyCostCents;
  return { totalMonthlyCostCents, operatingSurplusCents, operatingMargin: input.monthlyRevenueCents === 0 ? 0 : operatingSurplusCents / input.monthlyRevenueCents };
}

export function businessAdjustmentFactor(economics: BusinessEconomicsResult, monthlyRevenueCents: number, targetOperatingMargin: number, cap: number): BusinessAdjustmentResult {
  if (monthlyRevenueCents <= 0) return { businessAdjustmentFactor: 1, cappedForReview: false };
  const shortfall = monthlyRevenueCents * targetOperatingMargin - economics.operatingSurplusCents;
  if (shortfall <= 0) return { businessAdjustmentFactor: 1, cappedForReview: false };
  const rawFactor = (monthlyRevenueCents + shortfall) / monthlyRevenueCents;
  return { businessAdjustmentFactor: Math.min(rawFactor, cap), cappedForReview: rawFactor > cap };
}
