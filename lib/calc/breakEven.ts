/** Break-even (docs/05-calculations.md "Break-even"). */

/** Average money left per drink = (net sales − ingredients − card fees) ÷ drinks, over 28 days. */
export function avgMoneyLeftPerDrinkCents(
  netSalesCents: number,
  ingredientsCents: number,
  cardFeesCents: number,
  drinks: number,
): number {
  return drinks === 0 ? 0 : (netSalesCents - ingredientsCents - cardFeesCents) / drinks;
}

/** Daily costs to cover = running costs per day + average daily staff cost (planned for new cafés). */
export function dailyCostsToCoverCents(runningCostsPerDayCents: number, avgDailyStaffCostCents: number): number {
  return runningCostsPerDayCents + avgDailyStaffCostCents;
}

/** Drinks needed per day = ceil(daily costs to cover ÷ average money left per drink). */
export function drinksNeededPerDay(dailyCostsToCoverCentsValue: number, avgMoneyLeftPerDrinkCentsValue: number): number {
  if (avgMoneyLeftPerDrinkCentsValue <= 0) return Infinity;
  return Math.ceil(dailyCostsToCoverCentsValue / avgMoneyLeftPerDrinkCentsValue);
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
