export type ItemSalesPeriodTotals = { today: number | null; days7: number | null; days30: number | null };
export type ItemSalesDay = { date: string; quantity: number };
export type ItemSalesDailyByPeriod = { today: ItemSalesDay[] | null; days7: ItemSalesDay[] | null; days30: ItemSalesDay[] | null };
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

function dailyForPeriod(rows: readonly DatedItemQuantity[], itemId: string, coverage: SalesCoverage | null, today: string, days: number): ItemSalesDay[] | null {
  const start = addDays(today, -(days - 1));
  if (!coverage || coverage.start > start || coverage.end < today) return null;
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.menuItemId === itemId && row.businessDate >= start && row.businessDate <= today) {
      totals.set(row.businessDate, (totals.get(row.businessDate) ?? 0) + row.quantity);
    }
  }
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(start, index);
    return { date, quantity: totals.get(date) ?? 0 };
  });
}

/** Canonical daily item sales for small owner-facing charts. Zero-filled days are emitted only
 * when the same trusted sync coverage used by the period totals proves the whole range. */
export function itemSalesDailyByPeriod(rows: readonly DatedItemQuantity[], coverage: SalesCoverage | null, itemId: string, today: string): ItemSalesDailyByPeriod {
  return {
    today: dailyForPeriod(rows, itemId, coverage, today, 1),
    days7: dailyForPeriod(rows, itemId, coverage, today, 7),
    days30: dailyForPeriod(rows, itemId, coverage, today, 30),
  };
}
