export type ItemSalesPeriodTotals = { today: number | null; days7: number | null; days30: number | null };
export type DatedItemQuantity = { menuItemId: string; businessDate: string; quantity: number };
export type SalesCoverage = { start: string; end: string };

function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return next.toISOString().slice(0, 10);
}

function totalForPeriod(rows: readonly DatedItemQuantity[], itemId: string, coverage: SalesCoverage | null, today: string, days: number): number | null {
  const start = addDays(today, -(days - 1));
  if (!coverage || coverage.start > start || coverage.end < today) return null;
  return rows.filter((row) => row.menuItemId === itemId && row.businessDate >= start && row.businessDate <= today).reduce((sum, row) => sum + row.quantity, 0);
}

/** A zero is returned only when a trusted import/sync covers the whole period. Closed days need no rows. */
export function itemSalesPeriodTotals(rows: readonly DatedItemQuantity[], coverage: SalesCoverage | null, itemId: string, today: string): ItemSalesPeriodTotals {
  return {
    today: totalForPeriod(rows, itemId, coverage, today, 1),
    days7: totalForPeriod(rows, itemId, coverage, today, 7),
    days30: totalForPeriod(rows, itemId, coverage, today, 30),
  };
}
