import { describe, expect, it } from "vitest";
import { reconcileOperatingTasks, taskRefreshChangesRow } from "./reconcileTasks";
import type { OperatingTask } from "./tasks";

const stored: OperatingTask = { id: "data:2026-10:cost:rent", businessId: "b", agentId: "leo", kind: "data_quality",
  entityType: "expense_category", entityId: "rent", status: "needs_owner", payload: { categoryCode: "rent", note: "x" },
  confidence: "high", evidence: [{ source: "BusinessSnapshot", facts: { categoryCode: "rent", isMissing: true } }],
  createdAt: "2026-10-01T00:00:00.000Z" };

describe("Operations only rewrites tasks that changed", () => {
  it("skips a page-load refresh that would write the same row", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const derived = { ...stored, createdAt: now.toISOString() };
    const plan = reconcileOperatingTasks([stored], [derived], now);
    expect(plan.refresh).toHaveLength(1);
    expect(taskRefreshChangesRow(stored, plan.refresh[0])).toBe(false);
  });

  it("treats reordered stored JSON keys as the same", () => {
    const reordered = { ...stored, payload: { note: "x", categoryCode: "rent" },
      evidence: [{ facts: { isMissing: true, categoryCode: "rent" }, source: "BusinessSnapshot" }] } as OperatingTask;
    expect(taskRefreshChangesRow(stored, reordered)).toBe(false);
  });

  it("writes when a fact, status or owner field changed", () => {
    expect(taskRefreshChangesRow(stored, { ...stored, payload: { ...stored.payload, note: "y" } })).toBe(true);
    expect(taskRefreshChangesRow(stored, { ...stored, status: "handled", resolvedAt: "2026-10-30T00:00:00.000Z" })).toBe(true);
    expect(taskRefreshChangesRow(stored, { ...stored, evidence: [] })).toBe(true);
    expect(taskRefreshChangesRow(undefined, stored)).toBe(true);
  });
});
