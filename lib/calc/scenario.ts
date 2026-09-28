/** "Try a scenario": what a temporary ingredient-cost change (e.g. "give oat milk free for a
 * week") does to money the owner actually keeps. Not in docs/05-calculations.md (a new feature
 * requested live in a pilot demo) — same money-math rules apply: integer cents, round only at
 * the end. */

/** Extra (or saved, if negative) ingredient cost across every drink sold, over `days` days. */
export function scenarioExtraCostCents(deltaCentsPerDrink: number, avgDrinksPerDay: number, days: number): number {
  return Math.round(deltaCentsPerDrink * avgDrinksPerDay * days);
}

/** How many extra days this pushes full cost recovery back (negative = pulls it in), given the
 * business's average daily contribution toward its bills. */
export function scenarioDelayDays(extraCostCents: number, avgDailyContributionCents: number): number {
  if (avgDailyContributionCents === 0) return extraCostCents === 0 ? 0 : Infinity;
  return extraCostCents / avgDailyContributionCents;
}
