import { sumCents } from "./money";
import type { DailyFacts, HealthBand } from "./types";

export function netSalesCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.netSalesCents);
}

export function ingredientsCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.ingredientsCents);
}

export function staffCostCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.wagesCents + d.staffTaxCents);
}

export function cardFeesCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.cardFeesCents);
}

/** Total costs = ingredients + staff cost + card fees + running costs. */
export function totalCostsCentsForPeriod(days: DailyFacts[], runningCostsCents: number): number {
  return (
    ingredientsCentsForPeriod(days) +
    staffCostCentsForPeriod(days) +
    cardFeesCentsForPeriod(days) +
    runningCostsCents
  );
}

/** Owner profit = net sales − total costs. */
export function ownerProfitCentsForPeriod(days: DailyFacts[], runningCostsCents: number): number {
  return netSalesCentsForPeriod(days) - totalCostsCentsForPeriod(days, runningCostsCents);
}

// Health check bands (docs/05-calculations.md "Health check bands").
function bandFor(ratio: number, watchAt: number, highAt: number): HealthBand {
  if (ratio > highAt) return "high";
  if (ratio > watchAt) return "watch";
  return "healthy";
}

export function ingredientsHealthBand(ratio: number): HealthBand {
  return bandFor(ratio, 0.35, 0.4);
}

export function staffHealthBand(ratio: number): HealthBand {
  return bandFor(ratio, 0.35, 0.4);
}

export function combinedHealthBand(ratio: number): HealthBand {
  return bandFor(ratio, 0.6, 0.65);
}

export function ratio(numeratorCents: number, denominatorCents: number): number {
  return denominatorCents === 0 ? 0 : numeratorCents / denominatorCents;
}
