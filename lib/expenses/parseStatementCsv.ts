import Papa from "papaparse";

export type ParsedStatementLine = {
  i: number;
  date: string; // YYYY-MM-DD, best-effort
  description: string;
  amountCents: number; // negative = money out, per docs/06-integrations.md
  balanceCents: number | null;
};

export type ParsedStatement = {
  lines: ParsedStatementLine[];
  balanceCheck: { openingCents: number; closingCents: number; sumCents: number; ok: boolean } | null;
  unrecognizedColumns: boolean;
};

function findColumn(headers: string[], patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const hit = headers.find((h) => pattern.test(h));
    if (hit) return hit;
  }
  return null;
}

function toDateStr(raw: string): string {
  const trimmed = raw.trim();
  // MM/DD/YYYY or M/D/YY (common US bank export format)
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const [, m, d, y] = us;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Already ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return trimmed;
}

function toCents(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const negative = /^\(.*\)$/.test(cleaned); // "(123.45)" accounting notation for negative
  const numeric = Number(cleaned.replace(/[()]/g, ""));
  if (Number.isNaN(numeric)) return 0;
  const cents = Math.round(numeric * 100);
  return negative ? -Math.abs(cents) : cents;
}

/** Detects date/description/amount (or debit+credit) columns and handles common US bank CSV exports. */
export function parseStatementCsv(csvText: string): ParsedStatement {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
  const headers = (parsed.meta.fields ?? []).map((h) => h.trim());
  const lowerHeaders = headers.map((h) => h.toLowerCase());

  const dateCol = findColumn(lowerHeaders, [/^date$/, /trans.*date/, /posted/, /^date posted$/]);
  const descCol = findColumn(lowerHeaders, [/^description$/, /desc/, /memo/, /payee/, /^name$/, /transaction/]);
  const amountCol = findColumn(lowerHeaders, [/^amount$/]);
  const debitCol = findColumn(lowerHeaders, [/^debit$/, /withdrawal/]);
  const creditCol = findColumn(lowerHeaders, [/^credit$/, /deposit/]);
  const balanceCol = findColumn(lowerHeaders, [/balance/]);

  const headerByLower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const col = (name: string | null) => (name ? headerByLower.get(name) : undefined);

  const dateHeader = col(dateCol);
  const descHeader = col(descCol);
  const amountHeader = col(amountCol);
  const debitHeader = col(debitCol);
  const creditHeader = col(creditCol);
  const balanceHeader = col(balanceCol);

  const unrecognizedColumns = !dateHeader || !descHeader || (!amountHeader && !debitHeader && !creditHeader);

  const lines: ParsedStatementLine[] = (parsed.data as Record<string, string>[]).map((row, i) => {
    const date = dateHeader ? toDateStr(row[dateHeader] ?? "") : "";
    const description = descHeader ? (row[descHeader] ?? "").trim() : Object.values(row).join(" ").trim();

    let amountCents = 0;
    if (amountHeader) {
      amountCents = toCents(row[amountHeader] ?? "0");
    } else {
      const debit = debitHeader ? toCents(row[debitHeader] ?? "0") : 0;
      const credit = creditHeader ? toCents(row[creditHeader] ?? "0") : 0;
      amountCents = credit - Math.abs(debit); // debit column is money out
    }

    const balanceCents = balanceHeader && row[balanceHeader] ? toCents(row[balanceHeader]) : null;
    return { i, date, description, amountCents, balanceCents };
  });

  let balanceCheck: ParsedStatement["balanceCheck"] = null;
  const balances = lines.map((l) => l.balanceCents).filter((b): b is number => b !== null);
  if (balances.length >= 2) {
    const openingCents = balances[0] - lines[0].amountCents; // balance after first line minus its own delta
    const closingCents = balances[balances.length - 1];
    const sumCents = lines.reduce((s, l) => s + l.amountCents, 0);
    balanceCheck = { openingCents, closingCents, sumCents, ok: openingCents + sumCents === closingCents };
  }

  return { lines, balanceCheck, unrecognizedColumns };
}
