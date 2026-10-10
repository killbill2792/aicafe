import { suggestPrice, type CategoryPeerStats, type PricingResult } from "@/lib/calc";
import type { PricingBusinessInput, PricingItemInput } from "@/lib/data/getPricingInputs";
import { getPricingProfile, MIN_CATEGORY_PEERS } from "@/lib/pricing/profiles";

export type PricingRow = { itemId: string; result: PricingResult };
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

export function buildPricingViewModel(input: { items: PricingItemInput[]; business: PricingBusinessInput }): PricingRow[] {
  return input.items.map((item) => {
    const peers = input.items.filter((peer) => peer.id !== item.id && peer.category === item.category && peer.currentPriceCents > 0 && peer.productCostCents > 0);
    const categoryPeers: CategoryPeerStats = peers.length >= MIN_CATEGORY_PEERS ? { medianPriceCents: median(peers.map((peer) => peer.currentPriceCents)), medianProductCostPercent: median(peers.map((peer) => peer.productCostCents / peer.currentPriceCents)) } : null;
    const posSignal = { daysWithSalesInWindow: input.business.daysWithSalesInWindow, windowDays: input.business.windowDays, totalOrdersInWindow: input.business.totalOrdersInWindow, itemUnitsSoldInWindow: item.unitsSoldInWindow, monthlyRevenueCents: input.business.monthlyRevenueCents };
    const profile = getPricingProfile(item.category);
    const businessEconomicsComplete = input.business.processingFeesStatus !== "missing" && input.business.productCostsStatus !== "missing";
    const economics = businessEconomicsComplete ? { monthlyRevenueCents: input.business.monthlyRevenueCents, monthlyVariableProductCostCents: input.business.monthlyVariableProductCostCents, monthlyStaffCostCents: input.business.monthlyStaffCostCents, monthlyOperatingCostCents: input.business.monthlyOperatingCostCents, monthlyProcessingFeesCents: input.business.monthlyProcessingFeesCents } : null;
    return { itemId: item.id, result: suggestPrice({ productCostCents: item.productCostCents, currentPriceCents: item.currentPriceCents, productCostStatus: item.productCostStatus, profile, posSignal, economics, categoryPeers,
      businessEconomicsMissingInputs: [
        ...(input.business.processingFeesStatus === "missing" ? ["processingFees"] : []),
        ...(input.business.productCostsStatus === "missing" ? ["productCosts"] : []),
      ],
      businessEconomicsEstimatedInputs: [
        ...(input.business.processingFeesStatus === "estimated" ? ["processingFees"] : []),
        ...(input.business.productCostsStatus === "estimated" ? ["productCosts"] : []),
        ...(input.business.payrollCostsStatus !== "actual" || input.business.payrollTaxRateStatus !== "confirmed" ? ["payrollBurden"] : []),
        ...(input.business.operatingCostsStatus === "estimated" ? ["operatingCosts"] : []),
      ] }) };
  });
}
