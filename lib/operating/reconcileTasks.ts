import { priceChangeStatus } from "@/lib/calc/pricingStability";
import { COFFEE_SHOP_PROFILE } from "@/lib/pricing/profiles";
import type { OperatingTask } from "./tasks";

export const PRICE_RECOMMENDATION_COOLDOWN_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

export function isProjectionManagedTask(task: OperatingTask): boolean {
  if (task.kind === "price_review" || task.kind === "data_quality") return true;
  return task.kind === "supply_check" && /^supplies:\d{4}-\d{2}$/.test(task.id);
}

export type TaskReconciliation = {
  insert: OperatingTask[];
  refresh: OperatingTask[];
  expire: OperatingTask[];
};

function suggestedPriceCents(task: OperatingTask): number | null {
  const value = task.payload.suggestedPriceCents;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isSamePriceReviewEntity(left: OperatingTask, right: OperatingTask): boolean {
  return left.kind === "price_review" && right.kind === "price_review" &&
    left.entityType === right.entityType && left.entityId === right.entityId;
}

function latestPriceReviewForEntity(existing: OperatingTask[], current: OperatingTask): OperatingTask | undefined {
  return existing
    .filter((task) => isSamePriceReviewEntity(task, current))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function recommendationChangedMeaningfully(previous: OperatingTask, current: OperatingTask): boolean {
  const previousPrice = suggestedPriceCents(previous);
  const currentPrice = suggestedPriceCents(current);
  if (previousPrice === null || currentPrice === null) return true;
  return priceChangeStatus(
    previousPrice,
    currentPrice,
    COFFEE_SHOP_PROFILE.minimumPriceChangePercent,
    COFFEE_SHOP_PROFILE.minimumPriceChangeAmountCents,
  ).status === "REVIEW_PRICE";
}

function fixedSnoozeState(task: OperatingTask, now: Date): "active" | "due" | null {
  if (task.status !== "watching" || !["later_7", "later_30"].includes(String(task.payload.snoozeMode))) return null;
  if (typeof task.payload.snoozeUntil !== "string") return null;
  return new Date(task.payload.snoozeUntil).getTime() > now.getTime() ? "active" : "due";
}

function recommendationCooldownActive(task: OperatingTask, now: Date): boolean {
  if (task.status !== "handled" || !task.resolvedAt) return false;
  const ownerChoice = task.payload.ownerChoice;
  const startsCooldown = ownerChoice === "keep_price" ||
    (ownerChoice === "use_price" && task.payload.priceAppliedToPos === true);
  if (!startsCooldown) return false;
  const cooldownEndsAt = new Date(task.resolvedAt).getTime() +
    PRICE_RECOMMENDATION_COOLDOWN_DAYS * MILLISECONDS_PER_DAY;
  return now.getTime() < cooldownEndsAt;
}

function awaitingPriceApplication(task: OperatingTask): boolean {
  return task.kind === "price_review" && task.status === "watching" &&
    task.payload.awaitingPriceApplication === true;
}

/** Pure persistence plan for the deterministic task families owned by the current projection. */
export function reconcileOperatingTasks(existing: OperatingTask[], derived: OperatingTask[], now: Date): TaskReconciliation {
  const existingById = new Map(existing.map((task) => [task.id, task]));
  const currentIds = new Set(derived.map((task) => task.id));
  const insert: OperatingTask[] = [];
  const refresh: OperatingTask[] = [];
  const retainedIds = new Set(existing.filter(awaitingPriceApplication).map((task) => task.id));

  for (const current of derived) {
    const persisted = existingById.get(current.id);
    if (!persisted) {
      if (current.kind === "price_review") {
        const previous = latestPriceReviewForEntity(existing, current);
        if (previous) {
          if (awaitingPriceApplication(previous)) {
            retainedIds.add(previous.id);
            continue;
          }

          const snoozeState = fixedSnoozeState(previous, now);
          if (snoozeState === "active") {
            retainedIds.add(previous.id);
            continue;
          }

          if (recommendationCooldownActive(previous, now)) continue;

          const changedMeaningfully = recommendationChangedMeaningfully(previous, current);
          if (previous.status === "watching" && previous.payload.snoozeMode === "later_change" && !changedMeaningfully) {
            retainedIds.add(previous.id);
            continue;
          }

          // Once a fixed snooze is due, normal eligibility resumes even if the task id changed.
          // Otherwise ordinary recommendation drift stays anchored to the last surfaced suggestion.
          if (snoozeState !== "due" && !changedMeaningfully) {
            if (previous.status !== "handled" && previous.status !== "expired") retainedIds.add(previous.id);
            continue;
          }
        }
      }
      insert.push(current);
      continue;
    }

    // Workflow fields not emitted by the projection survive, while every freshly-derived fact wins.
    const snoozeDue = persisted.kind === "price_review" && persisted.status === "watching" &&
      typeof persisted.payload.snoozeUntil === "string" && new Date(persisted.payload.snoozeUntil) <= now;
    const handledPriceCooldownElapsed = persisted.kind === "price_review" && persisted.status === "handled" &&
      (persisted.payload.ownerChoice === "keep_price" ||
        (persisted.payload.ownerChoice === "use_price" && persisted.payload.priceAppliedToPos === true)) &&
      !recommendationCooldownActive(persisted, now);
    const status = persisted.status === "expired" || snoozeDue || handledPriceCooldownElapsed ? current.status : persisted.status;
    refresh.push({ ...current, status, createdAt: handledPriceCooldownElapsed ? current.createdAt : persisted.createdAt,
      payload: handledPriceCooldownElapsed
        ? current.payload
        : { ...persisted.payload, ...current.payload, ...(snoozeDue ? { snoozeMode: null, snoozeUntil: null } : {}) },
      ...(!handledPriceCooldownElapsed && (status === "expired" || status === "handled") && persisted.resolvedAt
        ? { resolvedAt: persisted.resolvedAt }
        : {}) });
  }

  const expire = existing
    .filter((task) => isProjectionManagedTask(task) && !currentIds.has(task.id) && !retainedIds.has(task.id) && task.status !== "handled" && task.status !== "expired")
    .map((task) => ({ ...task, status: "expired" as const, resolvedAt: now.toISOString() }));

  return { insert, refresh, expire };
}
