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

export type SalesRejectReason = "missing_item" | "missing_date" | "invalid_date" | "invalid_quantity" | "invalid_net_sales";

export type ParseSalesCsvResult = {
  valid: NormalizedSalesRow[];
  rejected: { reason: SalesRejectReason; count: number }[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseOptionalFee(raw: string): { processingFeeCents: number; processingFeeStatus: "actual" | "missing" } {
  const trimmed = raw.trim();
  if (!trimmed || !Number.isFinite(Number(trimmed.replace(/[$,()\s]/g, "")))) return { processingFeeCents: 0, processingFeeStatus: "missing" };
  return { processingFeeCents: Math.abs(toCents(trimmed)), processingFeeStatus: "actual" };
}

/**
 * Toast's "Sales summary / product mix" export (and equivalents) is one row per menu item per
 * day — already aggregated (docs/06-integrations.md). A per-selection export (one row per
 * individual sale) also parses here; `aggregateSalesRows` sums repeats by (date, item, category)
 * before anything is written, so either shape reconciles to the same totals instead of the last
 * row for a day silently overwriting the earlier ones.
 *
 * Rows are never silently dropped into a default value: a missing item/date skips the row, and an
 * unparseable date/quantity/net-sales value is rejected with a reason rather than coerced to 0 or
 * today's date, so the owner-facing summary can say exactly what wasn't imported and why.
 */
export function parseSalesCsv(rows: Record<string, string>[], mapping: SalesColumnMapping): ParseSalesCsvResult {
  const valid: NormalizedSalesRow[] = [];
  const rejectedCounts = new Map<SalesRejectReason, number>();
  const reject = (reason: SalesRejectReason) => rejectedCounts.set(reason, (rejectedCounts.get(reason) ?? 0) + 1);

  for (const row of rows) {
    const item = (row[mapping.item] ?? "").trim();
    const dateRaw = (row[mapping.date] ?? "").trim();
    if (!item) {
      reject("missing_item");
      continue;
    }
    if (!dateRaw) {
      reject("missing_date");
      continue;
    }
    const date = toDateStr(dateRaw);
    if (!ISO_DATE.test(date)) {
      reject("invalid_date");
      continue;
    }

    const quantityRaw = (row[mapping.quantity] ?? "").trim();
    const quantity = Number(quantityRaw.replace(/,/g, ""));
    if (quantityRaw && !Number.isFinite(quantity)) {
      reject("invalid_quantity");
      continue;
    }

    const netSalesRaw = (row[mapping.netSales] ?? "").trim();
    const netSalesCleaned = netSalesRaw.replace(/[$,\s()]/g, "");
    if (netSalesRaw && netSalesCleaned && Number.isNaN(Number(netSalesCleaned))) {
      reject("invalid_net_sales");
      continue;
    }

    const fee = parseOptionalFee(mapping.processingFee ? row[mapping.processingFee] ?? "" : "");
    valid.push({
      date,
      item,
      quantity: quantityRaw && Number.isFinite(quantity) ? quantity : 0,
      netSalesCents: toCents(netSalesRaw || "0"),
      category: mapping.category ? (row[mapping.category] ?? "").trim() || null : null,
      ...fee,
    });
  }

  return { valid, rejected: [...rejectedCounts.entries()].map(([reason, count]) => ({ reason, count })) };
}
