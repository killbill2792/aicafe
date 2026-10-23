/** Pure helpers shared by server coverage setup and the client fee form. */
export type FeeCoverageDay = {
  date: string;
  status: "actual" | "estimated" | "missing";
};

export function firstUncoveredSalesDay(days: FeeCoverageDay[], today: string): string {
  return days
    .filter((day) => day.status === "missing")
    .map((day) => day.date)
    .sort()[0] ?? today;
}

/** Never assume all sales are card sales unless there is exactly one known processor. */
export function initialCardSalesShareBps(
  savedShareBps: number | null,
  processorCount: number,
): number | null {
  return savedShareBps ?? (processorCount === 1 ? 10_000 : null);
}

/** The button always persists the user's current rate with the missing-history start date. */
export function missingCoverageSaveOptions(days: FeeCoverageDay[], today: string) {
  return { coverMissing: true as const, effectiveFrom: firstUncoveredSalesDay(days, today) };
}
