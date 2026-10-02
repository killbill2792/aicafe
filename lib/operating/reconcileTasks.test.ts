import { describe, expect, it } from "vitest";
import { reconcileOperatingTasks } from "./reconcileTasks";
import type { OperatingTask } from "./tasks";

const task = (overrides: Partial<OperatingTask> = {}): OperatingTask => ({ id: "data:2026-10:costs", businessId: "business-1", agentId: "leo", kind: "data_quality", status: "needs_owner", payload: { missingCostCount: 3 }, confidence: "high", evidence: [], createdAt: "2026-10-01T00:00:00.000Z", ...overrides });

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
    const current = task({ id: "price:item:500:625", kind: "price_review", agentId: "alex", entityType: "menu_item", entityId: "item" });
    const expired = { ...current, status: "expired" as const, resolvedAt: "2026-10-02T00:00:00.000Z" };
    const handled = { ...current, status: "handled" as const, resolvedAt: "2026-10-02T00:00:00.000Z" };
    const reactivated = reconcileOperatingTasks([expired], [current], new Date()).refresh[0];
    expect(reactivated.status).toBe("needs_owner");
    expect(reactivated.resolvedAt).toBeUndefined();
    expect(reconcileOperatingTasks([handled], [current], new Date()).refresh[0]).toMatchObject({ status: "handled", resolvedAt: handled.resolvedAt });
  });

  it("expires a superseded price recommendation for the same entity", () => {
    const oldTask = task({ id: "price:item:500:600", kind: "price_review", agentId: "alex", entityType: "menu_item", entityId: "item" });
    const current = task({ id: "price:item:500:625", kind: "price_review", agentId: "alex", entityType: "menu_item", entityId: "item" });
    expect(reconcileOperatingTasks([oldTask], [current], new Date()).expire.map((item) => item.id)).toEqual([oldTask.id]);
  });

  it("refreshes deterministic facts while preserving workflow-only payload fields", () => {
    const existing = task({ payload: { missingCostCount: 7, ownerNote: "Check Friday" } });
    const current = task({ payload: { missingCostCount: 2 } });
    expect(reconcileOperatingTasks([existing], [current], new Date()).refresh[0].payload).toEqual({ missingCostCount: 2, ownerNote: "Check Friday" });
  });
});
