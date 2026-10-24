/** Voids are a separate data source from sales. An actual sales rollup, including
 * a CSV-generated one, cannot prove that zero voids were recorded.
 *
 * No current persisted rollup has independent complete void-amount coverage.
 * Until a future verified importer can supply it, known-positive values are
 * observations only, never evidence of a complete monthly total.
 */
import { voidsAlert } from "./alerts";

export type VoidsRollup = {
  business_date: string;
  voids_cents: number;
  sales_data_status: string | null;
  voidsCoverage?: "complete" | "unknown";
};

export type VoidsSummary = {
  monthKey: string;
  thisMonthCents: number | null;
  previousThreeMonthAverageCents: number | null;
  /** Observed positive void amounts, or zeros with separate complete void coverage. */
  days: { date: string; cents: number }[];
};

function lastDayOfMonth(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function confirmedMonthTotal(rows: VoidsRollup[], monthKey: string, lastDay: string): number | null {
  // A missing day could include omitted voids. Do not infer it was a closed day.
  const byDate = new Map(rows.map(row => [row.business_date, row]));
  const first = `${monthKey}-01`;
  let total = 0;
  for (let day = first; day <= lastDay;) {
    const row = byDate.get(day);
    if (!row || row.voidsCoverage !== "complete" ||
        row.sales_data_status !== "actual" ||
        !Number.isSafeInteger(row.voids_cents) || row.voids_cents < 0) return null;
    total += row.voids_cents;
    if (!Number.isSafeInteger(total)) return null;
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  }
  return total;
}

/** Pure projection. `throughDate` is the last business-local day being compared.
 * Missing coverage never becomes zero, even if sales_data_status is actual.
 */
export function summarizeVoidsRollups(rows: VoidsRollup[], monthKey: string, throughDate = lastDayOfMonth(monthKey)): VoidsSummary {
  const [year, month] = monthKey.split("-").map(Number);
  const priorMonthKeys = [3, 2, 1].map(offset =>
    new Date(Date.UTC(year, month - offset - 1, 1)).toISOString().slice(0, 7)
  );
  const end = throughDate.startsWith(monthKey) && throughDate <= lastDayOfMonth(monthKey)
    ? throughDate : lastDayOfMonth(monthKey);
  const days = rows.filter(row =>
    row.business_date.startsWith(monthKey) && row.business_date <= end &&
    row.sales_data_status === "actual" &&
    Number.isSafeInteger(row.voids_cents) && row.voids_cents >= 0 &&
    (row.voidsCoverage === "complete" || row.voids_cents > 0)
  ).map(row => ({ date: row.business_date, cents: row.voids_cents }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const monthly = confirmedMonthTotal(rows, monthKey, end);
  const prior = priorMonthKeys.map(key => confirmedMonthTotal(rows, key, lastDayOfMonth(key)));
  return {
    monthKey,
    thisMonthCents: monthly,
    previousThreeMonthAverageCents: prior.some(total => total === null)
      ? null
      : Math.round((prior as number[]).reduce((sum, total) => sum + total, 0) / 3),
    days,
  };
}

/** The spike rule must not run when either period lacks independently verified void amounts. */
export function isUnusualVoids(summary: VoidsSummary): boolean {
  return summary.thisMonthCents !== null &&
    summary.previousThreeMonthAverageCents !== null &&
    voidsAlert(summary.thisMonthCents, summary.previousThreeMonthAverageCents);
}
