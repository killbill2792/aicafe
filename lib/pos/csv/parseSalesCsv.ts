import { toCents, toDateStr } from "./csvUtils";

export type SalesColumnMapping = {
  date: string;
  item: string;
  quantity: string;
  netSales: string;
  category?: string;
  processingFee?: string;
};

export type NormalizedSalesRow = {
  date: string; // YYYY-MM-DD
  item: string;
  quantity: number;
  netSalesCents: number;
  category: string | null;
  processingFeeCents: number;
  processingFeeStatus: "actual" | "missing";
};

export function salesCsvSyntheticOrderId(row: Pick<NormalizedSalesRow, "date" | "item">): string {
  return `csv-${row.date}-${row.item}`.slice(0, 120);
}

function parseOptionalFee(raw: string): { processingFeeCents: number; processingFeeStatus: "actual" | "missing" } {
  const trimmed = raw.trim();
  if (!trimmed || !Number.isFinite(Number(trimmed.replace(/[$,()\s]/g, "")))) return { processingFeeCents: 0, processingFeeStatus: "missing" };
  return { processingFeeCents: Math.abs(toCents(trimmed)), processingFeeStatus: "actual" };
}

/**
 * Toast's "Sales summary / product mix" export (and equivalents from other registers) is one row
 * per menu item per day — already aggregated, so "one synthetic order per item per day is fine"
 * (docs/06-integrations.md).
 */
export function parseSalesCsv(rows: Record<string, string>[], mapping: SalesColumnMapping): NormalizedSalesRow[] {
  return rows
    .map((row) => {
      const fee = parseOptionalFee(mapping.processingFee ? row[mapping.processingFee] ?? "" : "");
      return {
        date: toDateStr(row[mapping.date] ?? ""),
        item: (row[mapping.item] ?? "").trim(),
        quantity: Number((row[mapping.quantity] ?? "0").replace(/,/g, "")) || 0,
        netSalesCents: toCents(row[mapping.netSales] ?? "0"),
        category: mapping.category ? (row[mapping.category] ?? "").trim() || null : null,
        ...fee,
      };
    })
    .filter((r) => r.item && r.date);
}
