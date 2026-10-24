import { describe, expect, it } from "vitest";
import { breakEvenAction, firstMissingBillCategory, missingCostHref, salesSourcesForOrders } from "./moneyActions";
import type { RunningCostLine } from "@/lib/data/types";

const lines: RunningCostLine[] = [
  { categoryCode: "rent", label: "Rent", amountCents: 100, isEstimate: false, isMissing: false, isExpected: true },
  { categoryCode: "utilities_power", label: "Power", amountCents: 0, isEstimate: false, isMissing: true, isExpected: false },
  { categoryCode: "internet", label: "Internet", amountCents: 0, isEstimate: false, isMissing: true, isExpected: true },
];

describe("Money recovery button destinations", () => {
  it("chooses an upload without Toast, and Sync Toast only with a verified connection", () => {
    expect(breakEvenAction("NOT_ENOUGH_SALES", false, lines)).toEqual({ labelKey: "uploadSales", href: "/more/uploads/sales" });
    expect(breakEvenAction("NOT_ENOUGH_SALES", true, lines)).toEqual({ labelKey: "syncToast", href: "/more/toast" });
  });
  it("links the first expected missing bill rather than an unused category", () => {
    expect(firstMissingBillCategory(lines)).toBe("internet");
    expect(breakEvenAction("MISSING_BILLS", false, lines)).toEqual({ labelKey: "addBills", href: "/more/bills?category=internet" });
    expect(breakEvenAction("MISSING_BILLS", false, [])).toEqual({ labelKey: "addBills", href: "/more/bills" });
  });
  it("maps product costs and processing fees and does not invent an action for other math failures", () => {
    expect(breakEvenAction("MISSING_PRODUCT_COSTS", false, lines)).toEqual({ labelKey: "addProductCosts", href: "/menu" });
    expect(breakEvenAction("MISSING_PROCESSING_FEES", false, lines)).toEqual({ labelKey: "fixFees", href: "/more/processing-fees" });
    expect(breakEvenAction("VARIABLE_COSTS_TOO_HIGH", false, lines)).toBeNull();
  });
});

describe("period sales provenance", () => {
  it("uses actual order evidence rather than the café's connected provider", () => {
    expect(salesSourcesForOrders([{ pos_order_id: "csv-2026-10-10-1", processing_fee_provider: null }])).toEqual(["upload"]);
    expect(salesSourcesForOrders([{ pos_order_id: "sq1", processing_fee_provider: "square" }])).toEqual(["square"]);
    expect(salesSourcesForOrders([{ pos_order_id: "toast:restaurant:order", processing_fee_provider: null }])).toEqual(["toast"]);
  });
  it("retains each mixed source and unknown provenance rather than guessing", () => {
    expect(salesSourcesForOrders([
      { pos_order_id: "toast:1", processing_fee_provider: "toast" },
      { pos_order_id: "csv-2", processing_fee_provider: null },
    ])).toEqual(["toast", "upload"]);
    expect(salesSourcesForOrders([{ pos_order_id: "external", processing_fee_provider: null }])).toEqual(["unknown"]);
    expect(salesSourcesForOrders([])).toEqual(["unknown"]);
  });
});

describe("missing-cost deep links", () => {
  it("opens fixed bills at the missing monthly slot", () => {
    expect(missingCostHref("rent")).toBe("/more/bills?category=rent");
  });
  it("opens variable expenses with a validated money return URL", () => {
    expect(missingCostHref("supplies")).toBe("/add-cost/type?category=supplies&returnTo=%2Fmoney%3Fview%3Dprofit");
    expect(missingCostHref("repairs")).toBe("/add-cost/type?category=repairs&returnTo=%2Fmoney%3Fview%3Dprofit");
  });
});
