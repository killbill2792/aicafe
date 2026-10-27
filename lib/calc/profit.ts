import { roundHalfUpToCent, sumCents } from "./money";
import type { DailyFacts, HealthBand } from "./types";

export function netSalesCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.netSalesCents);
}

export function ingredientsCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.ingredientsCents);
}

/** A known-only wage sum on an incomplete day is NOT a complete labor cost.
 * Estimates remain usable with their separate quality labels. */
export function laborKnown<T extends Pick<DailyFacts,"wagesCents"|"staffTaxCents"|"laborWageStatus">>(
  day:T,
): day is T & {wagesCents:number;staffTaxCents:number} {
  return day.wagesCents!==null&&day.staffTaxCents!==null&&day.laborWageStatus!=="missing";
}

/** No clocked attendance is missing payroll evidence, not a verified $0 shift.
 * Return the provenance for every rollup, keeping any known-only cents separate. */
export function laborWageStatusFromTimecards(cards:readonly {
  hourly_wage_cents:number|null;wage_source:string|null
}[]): "actual"|"estimate"|"missing" {
  if(cards.length===0||cards.some(card=>card.hourly_wage_cents===null))return "missing";
  return cards.some(card=>card.wage_source==="estimate")?"estimate":"actual";
}

export function staffCostCentsForPeriod(days: DailyFacts[]): number | null {
  if(days.some(d=>!laborKnown(d)))return null;
  return sumCents(days, (d) => (d.wagesCents??0) + (d.staffTaxCents??0));
}

export function cardFeesCentsForPeriod(days: DailyFacts[]): number {
  return sumCents(days, (d) => d.cardFeesCents);
}

/** Total costs = ingredients + staff cost + card fees + running costs. */
export function totalCostsCentsForPeriod(days: DailyFacts[], runningCostsCents: number): number | null {
  const staff=staffCostCentsForPeriod(days);
  if(staff===null)return null;
  return (
    ingredientsCentsForPeriod(days) +
    staff +
    cardFeesCentsForPeriod(days) +
    runningCostsCents
  );
}

/** Owner profit = net sales − total costs. */
export function ownerProfitCentsForPeriod(days: DailyFacts[], runningCostsCents: number): number | null {
  const costs=totalCostsCentsForPeriod(days,runningCostsCents);
  return costs===null?null:netSalesCentsForPeriod(days)-costs;
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

/** Average order value = net sales ÷ orders, rounded half-up to the cent — money is integer cents
 * everywhere (CLAUDE.md rule 1), and this is a final displayed figure, not an intermediate used in
 * further math, so it rounds here rather than carrying fractional cents to the UI. */
export function averageOrderValueCents(netSalesCents: number, ordersCount: number): number {
  return ordersCount === 0 ? 0 : roundHalfUpToCent(netSalesCents / ordersCount);
}
