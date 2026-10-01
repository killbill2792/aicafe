export function baselinePriceCents(productCostCents: number, targetProductCostPercent: number): number {
  if (productCostCents <= 0 || targetProductCostPercent <= 0) return 0;
  return productCostCents / targetProductCostPercent;
}
