import { applyRounding } from "./pricingRounding";
import { businessEconomics } from "./pricingBusiness";
import type { BusinessEconomicsInput } from "./types";
import type { RecipeCostStatus } from "./ingredients";

export type ProfitGoalSimulationItemInput = {
  id: string;
  name: string;
  currentPriceCents: number;
  productCostCents: number;
  recipeStatus: RecipeCostStatus;
  unitsSoldInWindow: number;
};

export type ProfitGoalSimulationItem = {
  id: string;
  name: string;
  currentPriceCents: number;
  productCostCents: number | null;
  productCostPercent: number | null;
  simulatedPriceCents: number | null;
  changeCents: number | null;
};

export type ProfitGoalSimulation =
  | {
      kind: "ready";
      currentOperatingMargin: number;
      targetOperatingMargin: number;
      requiredRevenueCents: number;
      revenueMultiplier: number;
      requiredPriceIncreasePercent: number;
      largeChange: boolean;
      items: ProfitGoalSimulationItem[];
    }
  | { kind: "unavailable"; reason: "NO_REVENUE" | "TARGET_NOT_FEASIBLE" };

const SIMULATION_ROUNDING = { incrementCents: 25, mode: "up" as const };

/**
 * Pricing-only what-if. Assumes unit volume, recipe usage, staff plan and running costs remain
 * unchanged; processing fees scale with revenue at the observed rate.
 *
 * This is intentionally NOT the operational pricing engine:
 * - no POS-history gate;
 * - no 15% adjustment cap;
 * - existing prices never go down;
 * - nothing is persisted or sent to a POS.
 */
export function simulateProfitGoal(params: {
  economics: BusinessEconomicsInput;
  targetOperatingMargin: number;
  items: ProfitGoalSimulationItemInput[];
}): ProfitGoalSimulation {
  const { economics, items } = params;
  const target = params.targetOperatingMargin;
  if (!(economics.monthlyRevenueCents > 0)) return { kind: "unavailable", reason: "NO_REVENUE" };

  const current = businessEconomics(economics);
  const processingRate = Math.max(
    0,
    Math.min(0.99, economics.monthlyProcessingFeesCents / economics.monthlyRevenueCents),
  );
  const nonProcessingCosts =
    economics.monthlyVariableProductCostCents +
    economics.monthlyStaffCostCents +
    economics.monthlyOperatingCostCents;

  // If the café already meets/exceeds the target, do not lower prices to move it back down.
  let requiredRevenueCents = economics.monthlyRevenueCents;
  if (target > current.operatingMargin) {
    const denominator = 1 - processingRate - target;
    if (!(denominator > 0)) return { kind: "unavailable", reason: "TARGET_NOT_FEASIBLE" };
    requiredRevenueCents = Math.max(economics.monthlyRevenueCents, nonProcessingCosts / denominator);
  }

  const revenueMultiplier = Math.max(1, requiredRevenueCents / economics.monthlyRevenueCents);
  const requiredPriceIncreasePercent = (revenueMultiplier - 1) * 100;

  const simulatedItems = items.map((item): ProfitGoalSimulationItem => {
    const productCostCents = item.recipeStatus === "READY" && item.productCostCents > 0 ? item.productCostCents : null;
    const productCostPercent =
      productCostCents !== null && item.currentPriceCents > 0 ? productCostCents / item.currentPriceCents : null;

    if (item.currentPriceCents <= 0) {
      return {
        id: item.id,
        name: item.name,
        currentPriceCents: item.currentPriceCents,
        productCostCents,
        productCostPercent,
        simulatedPriceCents: null,
        changeCents: null,
      };
    }

    const simulated = Math.max(
      item.currentPriceCents,
      applyRounding(item.currentPriceCents * revenueMultiplier, SIMULATION_ROUNDING),
    );

    return {
      id: item.id,
      name: item.name,
      currentPriceCents: item.currentPriceCents,
      productCostCents,
      productCostPercent,
      simulatedPriceCents: simulated,
      changeCents: simulated - item.currentPriceCents,
    };
  });

  return {
    kind: "ready",
    currentOperatingMargin: current.operatingMargin,
    targetOperatingMargin: target,
    requiredRevenueCents: Math.round(requiredRevenueCents),
    revenueMultiplier,
    requiredPriceIncreasePercent,
    largeChange: requiredPriceIncreasePercent > 15,
    items: simulatedItems,
  };
}
