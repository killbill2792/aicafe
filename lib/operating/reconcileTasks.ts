import type { OperatingTask } from "./tasks";

const MANAGED_KINDS = new Set<OperatingTask["kind"]>(["price_review", "data_quality", "supply_check"]);

export type TaskReconciliation = {
  insert: OperatingTask[];
  refresh: OperatingTask[];
  expire: OperatingTask[];
};

/** Pure persistence plan for the deterministic task families owned by the current projection. */
export function reconcileOperatingTasks(existing: OperatingTask[], derived: OperatingTask[], now: Date): TaskReconciliation {
  const existingById = new Map(existing.map((task) => [task.id, task]));
  const currentIds = new Set(derived.map((task) => task.id));
  const insert: OperatingTask[] = [];
  const refresh: OperatingTask[] = [];

  for (const current of derived) {
    const persisted = existingById.get(current.id);
    if (!persisted) {
      insert.push(current);
      continue;
    }
    // Workflow fields not emitted by the projection survive, while every freshly-derived fact wins.
    refresh.push({ ...current, status: persisted.status, createdAt: persisted.createdAt,
      payload: { ...persisted.payload, ...current.payload },
      ...(persisted.resolvedAt ? { resolvedAt: persisted.resolvedAt } : {}) });
  }

  const expire = existing
    .filter((task) => MANAGED_KINDS.has(task.kind) && !currentIds.has(task.id) && task.status !== "handled" && task.status !== "expired")
    .map((task) => ({ ...task, status: "expired" as const, resolvedAt: now.toISOString() }));

  return { insert, refresh, expire };
}
