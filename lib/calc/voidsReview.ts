/** Pure, integer-cent comparison for a saved void alert's business month.
 * Rollup days without actual sales coverage are unknown, not zero.
 */
export type VoidsRollup = {
  business_date: string;
  voids_cents: number;
  sales_data_status: string | null;
};
export type VoidsSummary = {
  monthKey: string;
  thisMonthCents: number | null;
  previousThreeMonthAverageCents: number | null;
  days: { date: string; cents: number }[];
};

export function summarizeVoidsRollups(rows: VoidsRollup[], monthKey: string): VoidsSummary {
  const [year, month] = monthKey.split("-").map(Number);
  const priorMonthKeys = [3, 2, 1].map((offset) =>
    new Date(Date.UTC(year, month - offset - 1, 1)).toISOString().slice(0, 7)
  );
  const known = rows.filter((row) =>
    row.sales_data_status === "actual" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.business_date) &&
    Number.isSafeInteger(row.voids_cents)
  );
  const days = known.filter((row) => row.business_date.startsWith(monthKey))
    .map((row) => ({ date: row.business_date, cents: row.voids_cents }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const priorMonthTotals = priorMonthKeys.map((key) => {
    const found = known.filter((row) => row.business_date.startsWith(key));
    return found.length ? found.reduce((sum, row) => sum + row.voids_cents, 0) : null;
  });
  return {
    monthKey,
    thisMonthCents: days.length ? days.reduce((sum, row) => sum + row.cents, 0) : null,
    previousThreeMonthAverageCents: priorMonthTotals.some((cents) => cents === null)
      ? null
      : Math.round((priorMonthTotals as number[]).reduce((sum, cents) => sum + cents, 0) / 3),
    days,
  };
}
