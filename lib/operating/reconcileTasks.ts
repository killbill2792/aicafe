import type { OperatingTask } from "./tasks";

export function isProjectionManagedTask(task: OperatingTask): boolean {
  if (task.kind === "price_review" || task.kind === "data_quality") return true;
  return task.kind === "supply_check" && /^supplies:\d{4}-\d{2}$/.test(task.id);
}

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
    const snoozeDue = persisted.kind === "price_review" && persisted.status === "watching" &&
      typeof persisted.payload.snoozeUntil === "string" && new Date(persisted.payload.snoozeUntil) <= now;
    const status = persisted.status === "expired" || snoozeDue ? current.status : persisted.status;
    refresh.push({ ...current, status, createdAt: persisted.createdAt,
      payload: { ...persisted.payload, ...current.payload, ...(snoozeDue ? { snoozeMode: null, snoozeUntil: null } : {}) },
      ...(status !== "expired" && status !== "handled" ? {} : persisted.resolvedAt ? { resolvedAt: persisted.resolvedAt } : {}) });
  }

  const expire = existing
    .filter((task) => isProjectionManagedTask(task) && !currentIds.has(task.id) && task.status !== "handled" && task.status !== "expired")
    .map((task) => ({ ...task, status: "expired" as const, resolvedAt: now.toISOString() }));

  return { insert, refresh, expire };
}
