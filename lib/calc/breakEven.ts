/** Preserve the legacy public API while using shared B math. */
import {moneyLeftAfterPriceChangeCents,drinksTargetPerDay} from "@/lib/metrics/core/breakEven";

/** Drinks needed per day = ceil(daily costs to cover ÷ average money left per drink). */
export function drinksNeededPerDay(dailyCosts:number,moneyLeft:number):number{
  return drinksTargetPerDay(dailyCosts,moneyLeft);
}

/** What-if: price rise less the marginal percentage card fee; per-payment fixed fee stays unchanged. */
export function whatIfPriceChange(
  oldMoneyLeftCents: number,
  deltaCentsPerDrink: number,
  dailyCostsToCoverCentsValue: number,
  feeRate:number,
): number {
  return drinksNeededPerDay(dailyCostsToCoverCentsValue,
    moneyLeftAfterPriceChangeCents(oldMoneyLeftCents,deltaCentsPerDrink,feeRate));
}

/** What-if: one less person for a `hours`-long window removes hours × wage × (1 + tax rate) per day. */
export function whatIfOneLessPerson(
  dailyCostsToCoverCentsValue: number,
  oldMoneyLeftCents: number,
  hours: number,
  hourlyWageCents: number,
  payrollTaxRate: number,
): number {
  const removedCostCents = hours * hourlyWageCents * (1 + payrollTaxRate);
  return drinksNeededPerDay(dailyCostsToCoverCentsValue - removedCostCents, oldMoneyLeftCents);
}

/** What-if: an ingredient price change shifts the blended ingredient cost per drink by `deltaCentsPerDrink`. */
export function whatIfIngredientCostChange(
  oldMoneyLeftCents: number,
  deltaCentsPerDrink: number,
  dailyCostsToCoverCentsValue: number,
): number {
  return drinksNeededPerDay(dailyCostsToCoverCentsValue, oldMoneyLeftCents - deltaCentsPerDrink);
}
