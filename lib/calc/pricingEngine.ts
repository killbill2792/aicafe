import { MIN_ITEM_UNITS_SOLD } from "@/lib/pricing/profiles";
import { baselinePriceCents } from "./pricingBaseline";
import { businessAdjustmentFactor, businessEconomics } from "./pricingBusiness";
import { categorySanityWarnings } from "./pricingCategorySanity";
import { explanationCodeFor, pricingConfidence } from "./pricingConfidence";
import { detectPricingMode } from "./pricingMode";
import { applyRounding } from "./pricingRounding";
import { priceChangeStatus } from "./pricingStability";
import type { BusinessEconomicsInput, CategoryPeerStats, PosHistorySignal, PricingProfile, PricingResult } from "./types";

export type SuggestPriceInput = { productCostCents: number; currentPriceCents: number; hasCompleteRecipe: boolean; profile: PricingProfile; posSignal: PosHistorySignal; economics: BusinessEconomicsInput | null; categoryPeers: CategoryPeerStats };

export function suggestPrice(input: SuggestPriceInput): PricingResult {
  const productCostCents = Math.max(0, Math.round(input.productCostCents));
  const currentPriceCents = Math.max(0, Math.round(input.currentPriceCents));
  const calculationMode = detectPricingMode(input.posSignal);
  const economicsResult = input.economics ? businessEconomics(input.economics) : null;
  const adjustment = calculationMode === "BUSINESS_ADJUSTED" && economicsResult && input.economics
    ? businessAdjustmentFactor(economicsResult, input.economics.monthlyRevenueCents, input.profile.targetOperatingMargin, input.profile.businessAdjustmentCap)
    : { businessAdjustmentFactor: 1, cappedForReview: false };
  const baseline = baselinePriceCents(productCostCents, input.profile.targetProductCostPercent);
  const calculated = applyRounding(baseline * adjustment.businessAdjustmentFactor, input.profile.roundingRule);
  const stable = priceChangeStatus(currentPriceCents, calculated, input.profile.minimumPriceChangePercent, input.profile.minimumPriceChangeAmountCents);
  const enoughSample = input.posSignal.itemUnitsSoldInWindow >= MIN_ITEM_UNITS_SOLD;
  const confidence = pricingConfidence(calculationMode, input.hasCompleteRecipe, enoughSample, adjustment.cappedForReview);
  const warnings = categorySanityWarnings(calculated, calculated > 0 ? productCostCents / calculated : 0, input.categoryPeers);
  if (adjustment.cappedForReview) warnings.unshift("BUSINESS_ADJUSTMENT_CAPPED");
  if (!input.hasCompleteRecipe) warnings.push("INCOMPLETE_RECIPE");
  if (calculationMode === "BUSINESS_ADJUSTED" && !enoughSample) warnings.push("LOW_SAMPLE_SIZE");
  const dataQuality = { level: confidence.toLowerCase() as "low" | "medium" | "high", missingInputs: input.hasCompleteRecipe ? [] : ["recipeCost"], estimatedInputs: calculationMode === "BENCHMARK" ? ["coffeeShopPricingProfile"] : [], staleInputs: [] };
  const signals = stable.status === "REVIEW_PRICE" ? ["PRICE_REVIEW_REQUIRED"] : [];
  return {
    suggestedPriceCents: stable.recommendedPriceCents, productCostCents, baselinePriceCents: Math.round(baseline), calculatedSuggestedPriceCents: calculated,
    currentPriceCents, recommendedPriceCents: stable.recommendedPriceCents, calculationMode, businessAdjustmentFactor: adjustment.businessAdjustmentFactor,
    confidence, status: stable.status, explanationCode: explanationCodeFor(calculationMode, confidence),
    assumptions: calculationMode === "BENCHMARK" ? ["COFFEE_SHOP_PROFILE"] : ["RECENT_BUSINESS_ECONOMICS"], signals,
    explanationInputs: { targetProductCostPercent: input.profile.targetProductCostPercent, targetOperatingMargin: input.profile.targetOperatingMargin, reviewWindowDays: input.profile.reviewWindowDays },
    dataQuality, warnings,
  };
}
