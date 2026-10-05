import { describe, expect, it } from "vitest";
import { COFFEE_SHOP_PROFILE } from "@/lib/pricing/profiles";
import { PRICE_RECOMMENDATION_COOLDOWN_DAYS, reconcileOperatingTasks } from "./reconcileTasks";
import type { OperatingTask } from "./tasks";

const task = (overrides: Partial<OperatingTask> = {}): OperatingTask => ({ id: "data:2026-10:costs", businessId: "business-1", agentId: "leo", kind: "data_quality", status: "needs_owner", payload: { missingCostCount: 3 }, confidence: "high", evidence: [], createdAt: "2026-10-01T00:00:00.000Z", ...overrides });

const priceTask = (suggestedPriceCents: number, overrides: Partial<OperatingTask> = {}): OperatingTask => task({
  id: `price:item:500:${suggestedPriceCents}`,
  kind: "price_review",
  agentId: "alex",
  entityType: "menu_item",
  entityId: "item",
  payload: { suggestedPriceCents },
  ...overrides,
});

describe("reconcileOperatingTasks", () => {
  it("expires obsolete managed tasks but preserves handled history and unrelated staff tasks", () => {
    const result = reconcileOperatingTasks([
      task(),
      task({ id: "handled", status: "handled", resolvedAt: "2026-10-01T01:00:00.000Z" }),
      task({ id: "coverage", kind: "staff_coverage", agentId: "olivia", status: "needs_response" }),
      task({ id: "supplies:2026-09", kind: "supply_check", agentId: "maya", status: "watching" }),
      task({ id: "supply:item-id", kind: "supply_check", agentId: "maya", status: "needs_response" }),
    ], [], new Date("2026-10-02T00:00:00.000Z"));
    expect(result.expire.map((item) => item.id)).toEqual(["data:2026-10:costs", "supplies:2026-09"]);
  });

  it("reactivates the same deterministic data-quality task when its condition returns", () => {
    const expired = task({ status: "expired", resolvedAt: "2026-10-02T00:00:00.000Z" });
    const result = reconcileOperatingTasks([expired], [task()], new Date("2026-10-03T00:00:00.000Z"));
    expect(result.refresh[0]).toMatchObject({ status: "needs_owner" });
    expect(result.refresh[0].resolvedAt).toBeUndefined();
  });

  it("reactivates an identical expired price review but never reopens handled history", () => {
    const current = priceTask(625);
    const expired = { ...current, status: "expired" as const, resolvedAt: "2026-10-02T00:00:00.000Z" };
    const handled = { ...current, status: "handled" as const, resolvedAt: "2026-10-02T00:00:00.000Z" };
    const reactivated = reconcileOperatingTasks([expired], [current], new Date()).refresh[0];
    expect(reactivated.status).toBe("needs_owner");
    expect(reactivated.resolvedAt).toBeUndefined();
    expect(reconcileOperatingTasks([handled], [current], new Date()).refresh[0]).toMatchObject({ status: "handled", resolvedAt: handled.resolvedAt });
  });

  it("expires a materially superseded price recommendation for the same entity", () => {
    const oldTask = priceTask(600);
    const current = priceTask(650);
    expect(reconcileOperatingTasks([oldTask], [current], new Date()).expire.map((item) => item.id)).toEqual([oldTask.id]);
  });

  it("reuses the approved pricing stability thresholds", () => {
    expect(COFFEE_SHOP_PROFILE.minimumPriceChangePercent).toBe(0.05);
    expect(COFFEE_SHOP_PROFILE.minimumPriceChangeAmountCents).toBe(25);
    expect(PRICE_RECOMMENDATION_COOLDOWN_DAYS).toBe(30);
  });

  it("does not duplicate an identical recommendation when the observed current price changes its task id", () => {
    const previous = priceTask(600);
    const current = priceTask(600, { id: "price:item:525:600" });
    expect(reconcileOperatingTasks([previous], [current], new Date("2026-10-03T00:00:00Z"))).toEqual({ insert: [], refresh: [], expire: [] });
  });

  it("suppresses 5.50 to 5.75 drift using the existing 5 percent or 25 cent rule", () => {
    const previous = priceTask(550);
    const drifted = priceTask(575);
    expect(reconcileOperatingTasks([previous], [drifted], new Date("2026-10-03T00:00:00Z"))).toEqual({ insert: [], refresh: [], expire: [] });
  });

  it("allows a meaningful recommendation change beyond the existing threshold", () => {
    const previous = priceTask(550);
    const changed = priceTask(600);
    const result = reconcileOperatingTasks([previous], [changed], new Date("2026-10-03T00:00:00Z"));
    expect(result.insert).toEqual([changed]);
    expect(result.expire.map((entry) => entry.id)).toEqual([previous.id]);
  });

  it("refreshes deterministic facts while preserving workflow-only payload fields", () => {
    const existing = task({ payload: { missingCostCount: 7, ownerNote: "Check Friday" } });
    const current = task({ payload: { missingCostCount: 2 } });
    expect(reconcileOperatingTasks([existing], [current], new Date()).refresh[0].payload).toEqual({ missingCostCount: 2, ownerNote: "Check Friday" });
  });

  it("returns a still-current timed snooze only when it is due", () => {
    const current = priceTask(625);
    const snoozed = priceTask(625, { status: "watching", payload: { suggestedPriceCents: 625, snoozeMode: "later_7", snoozeUntil: "2026-10-09T00:00:00.000Z" } });
    expect(reconcileOperatingTasks([snoozed], [current], new Date("2026-10-08T23:59:00Z")).refresh[0].status).toBe("watching");
    const due = reconcileOperatingTasks([snoozed], [current], new Date("2026-10-09T00:00:00Z")).refresh[0];
    expect(due.status).toBe("needs_owner");
    expect(due.payload.snoozeUntil).toBeNull();
  });

  it("does not bypass Later 7 before expiry even for a material change, then resumes eligibility", () => {
    const snoozed = priceTask(550, { status: "watching", payload: { suggestedPriceCents: 550, snoozeMode: "later_7", snoozeUntil: "2026-10-09T00:00:00.000Z" } });
    const changed = priceTask(650);
    expect(reconcileOperatingTasks([snoozed], [changed], new Date("2026-10-08T23:59:59Z"))).toEqual({ insert: [], refresh: [], expire: [] });
    const due = reconcileOperatingTasks([snoozed], [changed], new Date("2026-10-09T00:00:00Z"));
    expect(due.insert).toEqual([changed]);
    expect(due.expire.map((entry) => entry.id)).toEqual([snoozed.id]);
  });

  it("does not bypass Later 30 before expiry even for a material change, then resumes eligibility", () => {
    const snoozed = priceTask(550, { status: "watching", payload: { suggestedPriceCents: 550, snoozeMode: "later_30", snoozeUntil: "2026-11-01T00:00:00.000Z" } });
    const changed = priceTask(650);
    expect(reconcileOperatingTasks([snoozed], [changed], new Date("2026-10-31T23:59:59Z"))).toEqual({ insert: [], refresh: [], expire: [] });
    const due = reconcileOperatingTasks([snoozed], [changed], new Date("2026-11-01T00:00:00Z"));
    expect(due.insert).toEqual([changed]);
    expect(due.expire.map((entry) => entry.id)).toEqual([snoozed.id]);
  });

  it("Later until change suppresses trivial drift but surfaces a meaningful change", () => {
    const snoozed = priceTask(600, { status: "watching", payload: { suggestedPriceCents: 600, snoozeMode: "later_change", snoozeUntil: null } });
    const drifted = priceTask(625);
    expect(reconcileOperatingTasks([snoozed], [drifted], new Date("2026-10-03T00:00:00Z"))).toEqual({ insert: [], refresh: [], expire: [] });

    const changed = priceTask(650);
    const result = reconcileOperatingTasks([snoozed], [changed], new Date("2026-10-03T00:00:00Z"));
    expect(result.insert).toEqual([changed]);
    expect(result.expire.map((entry) => entry.id)).toEqual([snoozed.id]);
  });

  it("keeps Keep current quiet for 30 days even after a material change", () => {
    const kept = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "keep_price" } });
    const changed = priceTask(700);
    expect(reconcileOperatingTasks([kept], [changed], new Date("2026-10-31T23:59:59Z")).insert).toEqual([]);
  });

  it("allows a meaningful recommendation after the Keep current cooldown", () => {
    const kept = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "keep_price" } });
    const changed = priceTask(700);
    expect(reconcileOperatingTasks([kept], [changed], new Date("2026-11-01T00:00:00Z")).insert).toEqual([changed]);
  });

  it("keeps an accepted recommendation watching until trusted price verification", () => {
    const accepted = priceTask(600, { status: "watching", payload: { suggestedPriceCents: 600, ownerChoice: "use_price", acceptedSuggestedPriceCents: 600, awaitingPriceApplication: true } });
    const changed = priceTask(750);
    expect(reconcileOperatingTasks([accepted], [changed], new Date("2026-10-03T00:00:00Z"))).toEqual({ insert: [], refresh: [], expire: [] });
    expect(reconcileOperatingTasks([accepted], [], new Date("2026-10-03T00:00:00Z"))).toEqual({ insert: [], refresh: [], expire: [] });
  });

  it("keeps a verified applied recommendation quiet for 30 days", () => {
    const applied = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "use_price", priceAppliedToPos: true } });
    const changed = priceTask(750, { id: "price:item:600:750" });
    expect(reconcileOperatingTasks([applied], [changed], new Date("2026-10-31T23:59:59Z")).insert).toEqual([]);
  });

  it("allows a meaningful recommendation after the verified-application cooldown", () => {
    const applied = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "use_price", priceAppliedToPos: true } });
    const changed = priceTask(750, { id: "price:item:600:750" });
    expect(reconcileOperatingTasks([applied], [changed], new Date("2026-11-01T00:00:00Z")).insert).toEqual([changed]);
  });

  it("keeps an exact-ID Keep current recommendation handled during its 30-day cooldown", () => {
    const kept = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "keep_price" } });
    const current = priceTask(600, { createdAt: "2026-10-20T00:00:00Z" });
    const refreshed = reconcileOperatingTasks([kept], [current], new Date("2026-10-20T00:00:00Z")).refresh[0];
    expect(refreshed).toMatchObject({ status: "handled", resolvedAt: kept.resolvedAt });
  });

  it("reactivates an exact-ID Keep current recommendation after its 30-day cooldown", () => {
    const kept = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "keep_price" } });
    const current = priceTask(600, { createdAt: "2026-11-01T00:00:00Z" });
    const refreshed = reconcileOperatingTasks([kept], [current], new Date("2026-11-01T00:00:00Z")).refresh[0];
    expect(refreshed.status).toBe("needs_owner");
    expect(refreshed.resolvedAt).toBeUndefined();
    expect(refreshed.createdAt).toBe(current.createdAt);
    expect(refreshed.payload.ownerChoice).toBeUndefined();
  });

  it("keeps an exact-ID verified applied recommendation handled during its 30-day cooldown", () => {
    const applied = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "use_price", priceAppliedToPos: true } });
    const current = priceTask(600, { createdAt: "2026-10-20T00:00:00Z" });
    const refreshed = reconcileOperatingTasks([applied], [current], new Date("2026-10-20T00:00:00Z")).refresh[0];
    expect(refreshed).toMatchObject({ status: "handled", resolvedAt: applied.resolvedAt });
  });

  it("reactivates an exact-ID verified applied recommendation after its 30-day cooldown", () => {
    const applied = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "use_price", priceAppliedToPos: true } });
    const current = priceTask(600, { createdAt: "2026-11-01T00:00:00Z" });
    const refreshed = reconcileOperatingTasks([applied], [current], new Date("2026-11-01T00:00:00Z")).refresh[0];
    expect(refreshed.status).toBe("needs_owner");
    expect(refreshed.resolvedAt).toBeUndefined();
    expect(refreshed.createdAt).toBe(current.createdAt);
    expect(refreshed.payload.ownerChoice).toBeUndefined();
    expect(refreshed.payload.priceAppliedToPos).toBeUndefined();
  });

  it("resurfaces the same Keep current suggestion after cooldown even when the current-price portion of the task id changed", () => {
    const kept = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "keep_price" } });
    const current = priceTask(600, { id: "price:item:525:600", createdAt: "2026-11-01T00:00:00Z" });
    expect(reconcileOperatingTasks([kept], [current], new Date("2026-11-01T00:00:00Z")).insert).toEqual([current]);
  });

  it("resurfaces the same verified-applied suggestion after cooldown even when the current-price portion of the task id changed", () => {
    const applied = priceTask(600, { status: "handled", resolvedAt: "2026-10-02T00:00:00Z", payload: { suggestedPriceCents: 600, ownerChoice: "use_price", priceAppliedToPos: true } });
    const current = priceTask(600, { id: "price:item:625:600", createdAt: "2026-11-01T00:00:00Z" });
    expect(reconcileOperatingTasks([applied], [current], new Date("2026-11-01T00:00:00Z")).insert).toEqual([current]);
  });
});
