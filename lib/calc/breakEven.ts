/** Preserve the legacy public API while using shared B math. */
import {moneyLeftPerDrinkCents,dailyBreakEvenCostsCents,
  drinksTargetPerDay} from "@/lib/metrics/core/breakEven";

/** Average money left per drink = (net sales − ingredients − card fees) ÷ drinks, over 28 days. */
export function avgMoneyLeftPerDrinkCents(netSalesCents:number,ingredientsCents:number,
  cardFeesCents:number,drinks:number):number{
  return moneyLeftPerDrinkCents(netSalesCents,ingredientsCents,cardFeesCents,drinks);
}

/** Daily costs to cover = running costs per day + average daily staff cost (planned for new cafés). */
export function dailyCostsToCoverCents(runningCosts:number,staffCost:number):number{
  return dailyBreakEvenCostsCents(runningCosts,staffCost);
}

/** Drinks needed per day = ceil(daily costs to cover ÷ average money left per drink). */
export function drinksNeededPerDay(dailyCosts:number,moneyLeft:number):number{
  return drinksTargetPerDay(dailyCosts,moneyLeft);
}

/** What-if: raise every price by `deltaCentsPerDrink` (fees held constant, per the doc). */
export function whatIfPriceChange(
  avgMoneyLeftPerDrinkCentsValue: number,
  deltaCentsPerDrink: number,
  dailyCostsToCoverCentsValue: number,
): number {
  return drinksNeededPerDay(dailyCostsToCoverCentsValue, avgMoneyLeftPerDrinkCentsValue + deltaCentsPerDrink);
}

/** What-if: one less person for a `hours`-long window removes hours × wage × (1 + tax rate) per day. */
export function whatIfOneLessPerson(
  dailyCostsToCoverCentsValue: number,
  avgMoneyLeftPerDrinkCentsValue: number,
  hours: number,
  hourlyWageCents: number,
  payrollTaxRate: number,
): number {
  const removedCostCents = hours * hourlyWageCents * (1 + payrollTaxRate);
  return drinksNeededPerDay(dailyCostsToCoverCentsValue - removedCostCents, avgMoneyLeftPerDrinkCentsValue);
}

/** What-if: an ingredient price change shifts the blended ingredient cost per drink by `deltaCentsPerDrink`. */
export function whatIfIngredientCostChange(
  avgMoneyLeftPerDrinkCentsValue: number,
  deltaCentsPerDrink: number,
  dailyCostsToCoverCentsValue: number,
): number {
  return drinksNeededPerDay(dailyCostsToCoverCentsValue, avgMoneyLeftPerDrinkCentsValue - deltaCentsPerDrink);
}
