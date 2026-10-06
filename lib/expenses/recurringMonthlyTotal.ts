type RecurringFrequency = "monthly" | "weekly" | "quarterly" | "yearly";

type RecurringAmount = { amountCents: number; frequency: RecurringFrequency };

export function recurringCostMonthlyEquivalentCents(
  cost: RecurringAmount,
): number {
  switch (cost.frequency) {
    case "weekly":
      return Math.round((cost.amountCents * 52) / 12);
    case "quarterly":
      return Math.round(cost.amountCents / 3);
    case "yearly":
      return Math.round(cost.amountCents / 12);
    case "monthly":
    default:
      return cost.amountCents;
  }
}

export function totalMonthlyRecurringCostsCents(
  costs: RecurringAmount[],
): number {
  return costs.reduce((sum, cost) => sum + recurringCostMonthlyEquivalentCents(cost), 0);
}
