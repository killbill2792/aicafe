import type { ProfitGoalSimulatorData } from "@/lib/data/getProfitGoalSimulatorData";

export type ProfitGoalBlocker = { kind: "sales" | "fees" | "costs" | "operating"; href: string };

/** Show *every* missing prerequisite; priority in the data reader only suppresses the estimate. */
export function profitGoalBlockers(data: ProfitGoalSimulatorData): ProfitGoalBlocker[] {
  return [
    ...(data.business.daysWithSalesInWindow < 7 ? [{ kind: "sales" as const, href: "/more/uploads/sales" }] : []),
    ...(data.business.processingFeesStatus === "missing" ? [{ kind: "fees" as const, href: "/more/processing-fees" }] : []),
    ...(data.items.some(item => item.unitsSoldInWindow > 0 && item.productCostStatus !== "READY")
      ? [{ kind: "costs" as const, href: "/menu" }] : []),
    ...(data.business.operatingCostsStatus === "missing" ? [{ kind: "operating" as const, href: "/more/bills" }] : []),
  ];
}
