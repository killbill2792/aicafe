import type { RunningCostLine } from "@/lib/data/types";

export type SalesSource = "toast" | "square" | "upload" | "unknown";
export type SalesOrderEvidence = {
  pos_order_id: string | null;
  processing_fee_provider: string | null;
};

/** Provider on canonical orders is evidence for this period; a connection by itself is not. */
export function salesSourcesForOrders(rows: readonly SalesOrderEvidence[]): SalesSource[] {
  if (rows.length === 0) return ["unknown"];
  const sources = new Set<SalesSource>();
  for (const row of rows) {
    const provider = row.processing_fee_provider?.toLowerCase() ?? "";
    const id = row.pos_order_id?.toLowerCase() ?? "";
    if (provider === "toast" || id.startsWith("toast:")) sources.add("toast");
    else if (provider === "square") sources.add("square");
    else if (provider === "csv" || id.startsWith("csv-") || id.startsWith("csv:")) sources.add("upload");
    else sources.add("unknown");
  }
  return (["toast", "square", "upload", "unknown"] as const).filter((source) => sources.has(source));
}

export function firstMissingBillCategory(lines: readonly RunningCostLine[]): string | null {
  return lines.find((line) => line.isMissing && line.isExpected)?.categoryCode ?? null;
}

const FIXED_BILLS = new Set(["rent", "utilities_power", "water", "internet", "insurance", "loan", "software"]);

/** Route a recurring fixed bill to its monthly slot, and a variable cost to manual entry. */
export function missingCostHref(category: string): string {
  if (FIXED_BILLS.has(category)) return `/more/bills?category=${encodeURIComponent(category)}`;
  const query = new URLSearchParams({ category, returnTo: "/money?view=profit" });
  return `/add-cost/type?${query.toString()}`;
}

export type RecoveryActionKey = "uploadSales" | "syncToast" | "addBills" | "addProductCosts" | "fixFees";

export function breakEvenAction(
  reason: string,
  toastConnected: boolean,
  lines: readonly RunningCostLine[],
): { labelKey: RecoveryActionKey; href: string } | null {
  switch (reason) {
    case "NOT_ENOUGH_SALES":
      return toastConnected
        ? { labelKey: "syncToast", href: "/more/toast" }
        : { labelKey: "uploadSales", href: "/more/uploads/sales" };
    case "MISSING_BILLS": {
      const category = firstMissingBillCategory(lines);
      return { labelKey: "addBills", href: category ? `/more/bills?category=${encodeURIComponent(category)}` : "/more/bills" };
    }
    case "MISSING_PRODUCT_COSTS":
      return { labelKey: "addProductCosts", href: "/menu" };
    case "MISSING_PROCESSING_FEES":
      return { labelKey: "fixFees", href: "/more/processing-fees" };
    default:
      return null;
  }
}
