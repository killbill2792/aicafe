import type { DataQuality, PricingResult } from "@/lib/calc";
import type { CafeSignal } from "./types";

export function signalsFromPricing(itemId: string, result: PricingResult): CafeSignal[] {
  // REVIEW_PRICE always carries a real, non-null recommendedPriceCents (see suggestPrice in
  // pricingEngine.ts — PRICE_UNAVAILABLE is the only status with a null price, and it's excluded
  // above); this check just makes that invariant explicit for the type system too.
  if (result.status !== "REVIEW_PRICE" || result.recommendedPriceCents === null) return [];
  return [{
    id: `pricing:${itemId}:${result.currentPriceCents}:${result.recommendedPriceCents}`,
    type: "PRICE_REVIEW_REQUIRED", entityType: "product", entityId: itemId,
    currentValue: result.currentPriceCents, previousValue: result.currentPriceCents,
    changePercent: result.currentPriceCents > 0 ? (result.recommendedPriceCents - result.currentPriceCents) / result.currentPriceCents : undefined,
    severity: result.confidence === "LOW" ? "info" : "warning", confidence: result.confidence.toLowerCase() as CafeSignal["confidence"],
    evidence: [
      { source: "PricingEngine", field: "recommendedPriceCents", value: result.recommendedPriceCents },
      { source: "PricingEngine", field: "productCostCents", value: result.productCostCents },
      { source: "PricingEngine", field: "calculationMode", value: result.calculationMode },
    ], dataQuality: result.dataQuality,
  }];
}

export function incompleteDataSignal(scope: string, quality: DataQuality): CafeSignal | null {
  if (quality.missingInputs.length === 0 && quality.staleInputs.length === 0) return null;
  return { id: `data:${scope}:${[...quality.missingInputs, ...quality.staleInputs].join(",")}`, type: "DATA_INCOMPLETE", entityType: scope, severity: "warning", confidence: "high", evidence: quality.missingInputs.map((field) => ({ source: "DataQuality", field, value: null })), dataQuality: quality };
}
