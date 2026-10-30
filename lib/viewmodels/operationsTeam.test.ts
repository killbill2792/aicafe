import { describe, expect, it } from "vitest";
import { suggestPrice } from "@/lib/calc/pricingEngine";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { agentForTask, type OperatingTask } from "@/lib/operating/tasks";
import type { BusinessSnapshot, RunningCostLine } from "@/lib/data/types";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { buildOperationsTeamViewModel, needsYouFromAttention } from "./operationsTeam";

const pricing = suggestPrice({
  productCostCents: 180,
  currentPriceCents: 550,
  productCostStatus: "READY",
  profile: getPricingProfile("ESPRESSO_DRINK"),
  posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 },
  economics: null,
  categoryPeers: null,
});

function snapshot(missingCount: number): BusinessSnapshot {
  const codes = ["other", "supplies", "rent", "water", "insurance", "software", "repairs"] as const;
  const runningCostLines = Array.from({ length: missingCount }, (_, index) => ({ categoryCode: codes[index % codes.length], label: `Missing ${index}`, amountCents: 0, isEstimate: false, isMissing: true })) as RunningCostLine[];
  return { business: { id: "business", name: "Cafe", timezone: "America/Los_Angeles", payrollTaxRate: 0 }, monthKey: "2026-10", runningCostLines } as BusinessSnapshot;
}

function menu(count: number): MenuControlItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, name: `Latte ${index}`, baseName: "Latte", sizeLabel: "16 oz", pricing })) as MenuControlItem[];
}

describe("operations team presentation", () => {
  it("keeps every generated task aligned with deterministic agent routing", () => {
    const team = buildOperationsTeamViewModel(snapshot(2), menu(2), new Date("2026-10-02T12:00:00Z"));
    for (const task of [...team.needsYou, ...team.handled, ...team.watching]) expect(task.agentId).toBe(agentForTask(task.kind));
  });

  it("preserves actual Alex and Leo counts above five", () => {
    const team = buildOperationsTeamViewModel(snapshot(7), menu(6), new Date("2026-10-02T12:00:00Z"));
    expect(team.members.find((member) => member.agentId === "alex")?.attentionCount).toBe(6);
    expect(team.members.find((member) => member.agentId === "leo")?.attentionCount).toBe(7);
  });

  it("stores Leo's stable category code instead of its display label", () => {
    const team = buildOperationsTeamViewModel(snapshot(1), [], new Date("2026-10-02T12:00:00Z"));
    const task = team.needsYou.find((item) => item.agentId === "leo")!;
    expect(task.id).toBe("data:2026-10:cost:other");
    expect(task.payload.categoryCode).toBe("other");
  });

  it("creates one Leo card per category so the count equals the Needs you list", () => {
    const team = buildOperationsTeamViewModel(snapshot(2), [], new Date("2026-10-02T12:00:00Z"));
    expect(team.needsYou.filter((task) => task.agentId === "leo")).toHaveLength(2);
    expect(team.members.find((member) => member.agentId === "leo")?.attentionCount).toBe(2);
  });
});

describe("Operations Needs you matches Home's attention list", () => {
  const items = [
    { id: "bill:rent", agentId: "leo" as const, displayTitle: "Add rent", actionLabel: "Fix", href: "/more/bills", impactCents: null },
    { id: "unmatched", agentId: "maya" as const, displayTitle: "3 items not matched", actionLabel: "Match", href: "/menu", impactCents: null },
    { id: "alert:1", agentId: "olivia" as const, displayTitle: "Missed meal break", actionLabel: "Open", href: "/staff", impactCents: 900 },
    { id: "price:item-0", agentId: "alex" as const, displayTitle: "Latte price is low", actionLabel: "Fix", href: "/menu/item-0", impactCents: 120 },
  ];
  const task = { id: "price:item-0", businessId: "business", agentId: "alex", kind: "price_review", status: "needs_owner",
    payload: {}, confidence: "high", evidence: [], createdAt: "2026-10-02T12:00:00Z" } satisfies OperatingTask;

  it("lists every Home item, in Home's order, so the counts are equal", () => {
    const { rows } = needsYouFromAttention(items, [task]);
    expect(rows.map((row) => row.id)).toEqual(items.map((item) => item.id));
  });

  it("counts each teammate's items from the same list", () => {
    const { counts } = needsYouFromAttention(items, [task]);
    expect(counts).toEqual({ alex: 1, olivia: 1, maya: 1, leo: 1 });
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(items.length);
  });

  it("keeps the stored task for a task row so its own actions stay available", () => {
    const { rows } = needsYouFromAttention(items, [task]);
    expect(rows[3]).toBe(task);
    expect(rows[0]).toBe(items[0]);
  });

  it("never adds a stored task that Home does not show", () => {
    const { rows } = needsYouFromAttention([], [task]);
    expect(rows).toEqual([]);
  });
});
