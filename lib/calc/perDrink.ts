/** Per-drink calculations (docs/05-calculations.md "Per-drink calculations"). All results are
 * fractional cents — round only for display (see money.ts). */

/** Staff cost per prep-second for a day = that day's loaded staff cost ÷ Σ(prep_seconds × qty sold). */
export function staffCostPerPrepSecond(dayLoadedStaffCostCents: number, totalPrepSecondsSold: number): number {
  return totalPrepSecondsSold === 0 ? 0 : dayLoadedStaffCostCents / totalPrepSecondsSold;
}

/** Staff time per drink = item.prep_seconds × staff cost per prep-second (avg over last 28 days). */
export function staffTimePerDrinkCents(prepSeconds: number, staffCostPerPrepSecondCents: number): number {
  return prepSeconds * staffCostPerPrepSecondCents;
}

/** Card fee per drink = price × effective fee rate. */
export function cardFeePerDrinkCents(priceCents: number, effectiveFeeRate: number): number {
  return priceCents * effectiveFeeRate;
}

/** Rent & bills share per drink = (month's running costs ÷ days in month) ÷ avg drinks/day (28d). */
export function rentBillsSharePerDrinkCents(runningCostsPerDayCents: number, avgDrinksPerDay: number): number {
  return avgDrinksPerDay === 0 ? 0 : runningCostsPerDayCents / avgDrinksPerDay;
}

/** Extra money from one more drink = price − ingredients − card fee − staff time. */
export function extraMoneyFromOneMoreDrinkCents(
  priceCents: number,
  ingredientsCents: number,
  cardFeeCents: number,
  staffTimeCents: number,
): number {
  return priceCents - ingredientsCents - cardFeeCents - staffTimeCents;
}

/** True profit per drink = extra money from one more drink − rent & bills share. */
export function trueProfitPerDrinkCents(extraMoneyCents: number, rentBillsShareCents: number): number {
  return extraMoneyCents - rentBillsShareCents;
}

export function effectiveFeeRate(cardFeesCentsOver28Days: number, netSalesCentsOver28Days: number): number {
  return netSalesCentsOver28Days === 0 ? 0 : cardFeesCentsOver28Days / netSalesCentsOver28Days;
}
