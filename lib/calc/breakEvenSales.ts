export type BreakEvenSalesResult =
  | {
      kind: "ready";
      monthlyBillsCents: number;
      monthlyStaffCents: number;
      fixedMonthlyCostsCents: number;
      ingredientRate: number;
      processingFeeRate: number;
      contributionRate: number;
      breakEvenSalesCents: number;
      ingredientCostsAtBreakEvenCents: number;
      processingFeesAtBreakEvenCents: number;
    }
  | { kind: "unavailable"; reason: "NO_SALES" | "VARIABLE_COSTS_TOO_HIGH" };

export function calculateBreakEvenSales(params: {
  monthlyBillsCents: number;
  monthlyStaffCents: number;
  observedSalesCents: number;
  observedIngredientCents: number;
  observedProcessingFeesCents: number;
}): BreakEvenSalesResult {
  const {
    monthlyBillsCents,
    monthlyStaffCents,
    observedSalesCents,
    observedIngredientCents,
    observedProcessingFeesCents,
  } = params;
  if (!(observedSalesCents > 0)) return { kind: "unavailable", reason: "NO_SALES" };

  const ingredientRate = Math.max(0, observedIngredientCents / observedSalesCents);
  const processingFeeRate = Math.max(0, observedProcessingFeesCents / observedSalesCents);
  const contributionRate = 1 - ingredientRate - processingFeeRate;
  if (!(contributionRate > 0)) return { kind: "unavailable", reason: "VARIABLE_COSTS_TOO_HIGH" };

  const fixedMonthlyCostsCents = Math.max(0, monthlyBillsCents) + Math.max(0, monthlyStaffCents);
  const breakEvenSalesCents = Math.round(fixedMonthlyCostsCents / contributionRate);
  return {
    kind: "ready",
    monthlyBillsCents: Math.max(0, monthlyBillsCents),
    monthlyStaffCents: Math.max(0, monthlyStaffCents),
    fixedMonthlyCostsCents,
    ingredientRate,
    processingFeeRate,
    contributionRate,
    breakEvenSalesCents,
    ingredientCostsAtBreakEvenCents: Math.round(breakEvenSalesCents * ingredientRate),
    processingFeesAtBreakEvenCents: Math.round(breakEvenSalesCents * processingFeeRate),
  };
}
