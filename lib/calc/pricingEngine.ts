import { MIN_ITEM_UNITS_SOLD } from "@/lib/pricing/profiles";
import type { RecipeCostStatus } from "./ingredients";
import { baselinePriceCents } from "./pricingBaseline";
import { businessAdjustmentFactor, businessEconomics } from "./pricingBusiness";
import { categorySanityWarnings } from "./pricingCategorySanity";
import { explanationCodeFor, pricingConfidence } from "./pricingConfidence";
import { detectPricingMode } from "./pricingMode";
import { applyRounding } from "./pricingRounding";
import { priceChangeStatus } from "./pricingStability";
import type { BusinessEconomicsInput, CategoryPeerStats, PosHistorySignal, PricingProfile, PricingResult } from "./types";

/** `productCostCents` is meaningful only when `productCostStatus === "READY"` — carrying the actual
 * status (not a collapsed boolean) is what lets this engine tell "no recipe yet" apart from
 * "priced, but the cost happens to be tiny" instead of treating both as the same missing-data
 * case (the mismatch this type previously had with getMenuItemsForEdit's own RecipeCostStatus). */
export type SuggestPriceInput = { productCostCents: number; currentPriceCents: number; productCostStatus?: RecipeCostStatus; /** @deprecated use productCostStatus */ recipeStatus?: RecipeCostStatus; profile: PricingProfile; posSignal: PosHistorySignal; economics: BusinessEconomicsInput | null; categoryPeers: CategoryPeerStats; businessEconomicsMissingInputs?: string[]; businessEconomicsEstimatedInputs?: string[] };

function resolvedProductCostStatus(input: SuggestPriceInput): RecipeCostStatus {
  return input.productCostStatus ?? input.recipeStatus ?? "NO_RECIPE";
}

function unavailableResult(input: SuggestPriceInput, currentPriceCents: number, calculationMode: PricingResult["calculationMode"], costStatus = resolvedProductCostStatus(input)): PricingResult {
  // Missing recipe, missing ingredient cost, or a genuinely zero-cost recipe — none of these
  // support a real price recommendation. Surface that explicitly as PRICE_UNAVAILABLE with null
  // price fields; never fall through to the baseline/rounding math, which would otherwise compute
  // a numeric $0.00 from a 0 or non-existent product cost and present it as a real suggestion.
  const confidence = pricingConfidence(calculationMode, false, false, false);
  const missingInput = costStatus === "NO_RECIPE" ? "recipe" : costStatus === "MISSING_INGREDIENT_COST" ? "ingredientCost" : "productCost";
  return {
    productCostCents: costStatus === "READY" ? input.productCostCents : null,
    baselinePriceCents: null,
    calculatedSuggestedPriceCents: null,
    currentPriceCents,
    recommendedPriceCents: null,
    calculationMode,
    businessAdjustmentFactor: 1,
    confidence,
    status: "PRICE_UNAVAILABLE",
    explanationCode: explanationCodeFor(calculationMode, confidence),
    assumptions: [],
    signals: [],
    explanationInputs: { targetProductCostPercent: input.profile.targetProductCostPercent, targetOperatingMargin: input.profile.targetOperatingMargin, reviewWindowDays: input.profile.reviewWindowDays },
    dataQuality: { level: confidence.toLowerCase() as "low" | "medium" | "high", missingInputs: [missingInput, ...(input.businessEconomicsMissingInputs ?? [])], estimatedInputs: input.businessEconomicsEstimatedInputs ?? [], staleInputs: [] },
    warnings: ["INCOMPLETE_RECIPE"],
  };
}

export function suggestPrice(input: SuggestPriceInput): PricingResult {
  const currentPriceCents = Math.max(0, Math.round(input.currentPriceCents));
  const historyMode = detectPricingMode(input.posSignal);
  const calculationMode = historyMode === "BUSINESS_ADJUSTED" && !input.economics ? "BENCHMARK" : historyMode;

  // A genuinely positive, possibly-fractional product cost is the only case that supports a real
  // recommendation — e.g. 1.5¢ for 3ml of milk at $0.50/ml is valid, not "missing." Anything else
  // (no recipe, an unpriced ingredient, or a recipe that priced to exactly 0) is PRICE_UNAVAILABLE.
  const costStatus = resolvedProductCostStatus(input);
  if (costStatus !== "READY" || !(input.productCostCents > 0)) {
    return unavailableResult(input, currentPriceCents, calculationMode, costStatus);
  }

  // Precision is preserved through this math (per docs/05-calculations.md / lib/calc/types.ts:
  // "intermediate math may be fractional cents... only round for display") — productCostCents
  // flows into baselinePriceCents at full precision; rounding happens only in applyRounding below
  // and in the output fields at the very end.
  const productCostCents = input.productCostCents;
  const economicsResult = input.economics ? businessEconomics(input.economics) : null;
  const adjustment = calculationMode === "BUSINESS_ADJUSTED" && economicsResult && input.economics
    ? businessAdjustmentFactor(economicsResult, input.economics.monthlyRevenueCents, input.profile.targetOperatingMargin, input.profile.businessAdjustmentCap)
    : { businessAdjustmentFactor: 1, cappedForReview: false };
  const baseline = baselinePriceCents(productCostCents, input.profile.targetProductCostPercent);
  const rawBeforeRounding = baseline * adjustment.businessAdjustmentFactor;
  // A genuinely positive raw price must never round down to literal $0.00 — that reads as "free"
  // or "broken," not "cheap." Floor at one rounding increment instead of letting applyRounding
  // crush a small-but-real price (e.g. 6.67¢ at a 25¢ increment) to zero.
  const calculatedRaw = rawBeforeRounding > 0 ? Math.max(applyRounding(rawBeforeRounding, input.profile.roundingRule), input.profile.roundingRule.incrementCents) : 0;
  // Existing market price is evidence. Without demand/elasticity evidence, AI Cafe may recommend
  // an increase but never a decrease merely to pull a healthy item toward a benchmark ratio.
  const calculated = currentPriceCents > 0 ? Math.max(currentPriceCents, calculatedRaw) : calculatedRaw;
  const stable = priceChangeStatus(currentPriceCents, calculated, input.profile.minimumPriceChangePercent, input.profile.minimumPriceChangeAmountCents);
  const enoughSample = input.posSignal.itemUnitsSoldInWindow >= MIN_ITEM_UNITS_SOLD;
  const confidence = pricingConfidence(calculationMode, true, enoughSample, adjustment.cappedForReview);
  const warnings = categorySanityWarnings(calculated, calculated > 0 ? productCostCents / calculated : 0, input.categoryPeers);
  if (adjustment.cappedForReview) warnings.unshift("BUSINESS_ADJUSTMENT_CAPPED");
  if (calculationMode === "BUSINESS_ADJUSTED" && !enoughSample) warnings.push("LOW_SAMPLE_SIZE");
  const dataQuality = { level: confidence.toLowerCase() as "low" | "medium" | "high", missingInputs: input.businessEconomicsMissingInputs ?? [], estimatedInputs: [...(calculationMode === "BENCHMARK" ? ["coffeeShopPricingProfile"] : []), ...(input.businessEconomicsEstimatedInputs ?? [])], staleInputs: [] };
  const signals = stable.status === "REVIEW_PRICE" ? ["PRICE_REVIEW_REQUIRED"] : [];
  return {
    productCostCents: Math.round(productCostCents), baselinePriceCents: Math.round(baseline), calculatedSuggestedPriceCents: calculated,
    currentPriceCents, recommendedPriceCents: stable.recommendedPriceCents, calculationMode, businessAdjustmentFactor: adjustment.businessAdjustmentFactor,
    confidence, status: stable.status, explanationCode: explanationCodeFor(calculationMode, confidence),
    assumptions: calculationMode === "BENCHMARK" ? ["COFFEE_SHOP_PROFILE"] : ["RECENT_BUSINESS_ECONOMICS"], signals,
    explanationInputs: { targetProductCostPercent: input.profile.targetProductCostPercent, targetOperatingMargin: input.profile.targetOperatingMargin, reviewWindowDays: input.profile.reviewWindowDays },
    dataQuality, warnings,
  };
}
