import type { PricingConfidence, PricingMode, PricingResult } from "./types";

export function pricingConfidence(mode: PricingMode, complete: boolean, enoughSample: boolean, capped: boolean): PricingConfidence {
  if (mode === "BENCHMARK") return "MEDIUM";
  const failures = [!complete, !enoughSample, capped].filter(Boolean).length;
  return failures === 0 ? "HIGH" : failures === 1 ? "MEDIUM" : "LOW";
}
export function explanationCodeFor(mode: PricingMode, confidence: PricingConfidence): PricingResult["explanationCode"] {
  if (confidence === "LOW") return "INCOMPLETE_DATA_EXPLAINER";
  return mode === "BENCHMARK" ? "BENCHMARK_EXPLAINER" : "BUSINESS_ADJUSTED_EXPLAINER";
}
