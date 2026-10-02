export type ItemSalesPeriodTotals = { today: number | null; days7: number | null; days30: number | null };
export type DatedItemQuantity = { menuItemId: string; businessDate: string; quantity: number };

function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return next.toISOString().slice(0, 10);
}

function totalForPeriod(rows: readonly DatedItemQuantity[], itemId: string, coverage: Set<string>, today: string, days: number): number | null {
  const start = addDays(today, -(days - 1));
  for (let offset = 0; offset < days; offset += 1) if (!coverage.has(addDays(start, offset))) return null;
  return rows.filter((row) => row.menuItemId === itemId && row.businessDate >= start && row.businessDate <= today).reduce((sum, row) => sum + row.quantity, 0);
}

/** A zero is returned only when every calendar day in the period has trusted rollup coverage. */
export function itemSalesPeriodTotals(rows: readonly DatedItemQuantity[], coverageDates: readonly string[], itemId: string, today: string): ItemSalesPeriodTotals {
  const coverage = new Set(coverageDates);
  return {
    today: totalForPeriod(rows, itemId, coverage, today, 1),
    days7: totalForPeriod(rows, itemId, coverage, today, 7),
    days30: totalForPeriod(rows, itemId, coverage, today, 30),
  };
}
