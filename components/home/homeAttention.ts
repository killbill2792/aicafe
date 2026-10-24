import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import type { ExpenseCategoryCode } from "@/lib/constants";

/** All destinations are owner-facing, existing routes. Never open an external alert URL. */
export type AttentionTarget =
  | { kind: "bill"; category: ExpenseCategoryCode }
  | { kind: "missing_sales"; toastConnected: boolean }
  | { kind: "fees" | "unmatched" | "pantry" }
  | { kind: "reconnect"; provider: string }
  | { kind: "alert" | "price" | "staff" | "task"; href: string };

export function homeAttentionHref(target: AttentionTarget): string {
  switch (target.kind) {
    case "bill": return missingCostDestination(target.category);
    case "missing_sales": return target.toastConnected ? "/more/toast" : "/more/uploads/sales";
    case "fees": return "/more/processing-fees";
    case "unmatched": return "/menu/import-review";
    case "pantry": return "/menu/pantry";
    case "reconnect": return target.provider === "toast" ? "/more/toast" : "/more";
    case "alert":
    case "price":
    case "staff":
    case "task":
      return target.href.startsWith("/") && !target.href.startsWith("//") && !target.href.includes("\\")
        ? target.href : "/operations";
  }
}

/** Keep an employee and date together in schedule links (including rule alerts). */
export function homeShiftHref(employeeId?: string | null, date?: string | null): string {
  const query = new URLSearchParams({tab:"schedule"});
  if (employeeId) query.set("employee", employeeId);
  if (date) {
    query.set("date", date);
    // The current Staff screen selects weeks via ?week=; Step 13 will also
    // honor date/employee directly. Supply both so neither version loses the
    // owner's intended scheduling week.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const parsed = new Date(date + "T12:00:00Z");
      if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === date) {
        const monday = new Date(parsed.getTime() - ((parsed.getUTCDay() + 6) % 7) * 86_400_000);
        query.set("week", monday.toISOString().slice(0,10));
      }
    }
  }
  return "/staff?" + query.toString();
}

export type HomeAttentionItem = {
  id: string;
  title: string;
  actionLabel: string;
  href: string;
  /** A known, safe amount in cents. null means unquantified, not zero dollars. */
  impactCents: number | null;
};

/** Sort a copy, with unknown impacts after known impacts. Keep stable input order on ties. */
export function prioritizeHomeAttention(items: HomeAttentionItem[], cap = 5): { visible: HomeAttentionItem[]; total: number } {
  const unique = new Map(items.map(item => [item.id, item]));
  const ranked = [...unique.values()].map((item, order) => ({ item, order }));
  ranked.sort((a, b) => {
    const aImpact = a.item.impactCents;
    const bImpact = b.item.impactCents;
    const aKnown = aImpact !== null && Number.isSafeInteger(aImpact) && aImpact >= 0;
    const bKnown = bImpact !== null && Number.isSafeInteger(bImpact) && bImpact >= 0;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown && aImpact !== bImpact) return (bImpact ?? 0) - (aImpact ?? 0);
    return a.order - b.order;
  });
  return { visible: ranked.slice(0, Math.max(0, cap)).map(({ item }) => item), total: ranked.length };
}
