import type { PricingStatus } from "./types";

export function priceChangeStatus(currentPriceCents: number, calculatedSuggestedPriceCents: number, minimumPriceChangePercent: number, minimumPriceChangeAmountCents: number): { status: PricingStatus; recommendedPriceCents: number } {
  if (currentPriceCents <= 0) return { status: "NEW_PRICE", recommendedPriceCents: calculatedSuggestedPriceCents };
  const threshold = Math.max(currentPriceCents * minimumPriceChangePercent, minimumPriceChangeAmountCents);
  return Math.abs(calculatedSuggestedPriceCents - currentPriceCents) < threshold
    ? { status: "KEEP_CURRENT_PRICE", recommendedPriceCents: currentPriceCents }
    : { status: "REVIEW_PRICE", recommendedPriceCents: calculatedSuggestedPriceCents };
}
