import { toCents, toDateStr } from "./csvUtils";

export type ProcessingFeeColumnMapping = { date: string; processingFee: string };
export type NormalizedProcessingFeeRow = { date: string; actualProcessingFeeCents: number };

export function processingFeeTotalsByDate(rows: NormalizedProcessingFeeRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.date, (totals.get(row.date) ?? 0) + row.actualProcessingFeeCents);
  return totals;
}

/** Generic POS/processor report rows. Provider-signed amounts are normalized to positive costs. */
export function parseProcessingFeesCsv(
  rows: Record<string, string>[],
  mapping: ProcessingFeeColumnMapping,
): { valid: NormalizedProcessingFeeRow[]; invalidRows: number } {
  const valid: NormalizedProcessingFeeRow[] = [];
  let invalidRows = 0;
  for (const row of rows) {
    const date = toDateStr(row[mapping.date] ?? "");
    const rawFee = (row[mapping.processingFee] ?? "").trim();
    const numericFee = Number(rawFee.replace(/[$,()\s]/g, ""));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !rawFee || !Number.isFinite(numericFee)) {
      invalidRows += 1;
      continue;
    }
    valid.push({ date, actualProcessingFeeCents: Math.abs(toCents(rawFee)) });
  }
  return { valid, invalidRows };
}
